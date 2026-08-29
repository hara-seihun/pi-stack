/**
 * Handle Cursor InteractionQuery messages so the AgentService stream never
 * stalls waiting for a permission / interaction reply that Pi never sends.
 *
 * Unanswered interaction queries are a primary cause of "model stops after a
 * few minutes" — Cursor parks the run until InteractionResponse arrives.
 */
import { create, toBinary } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  AskQuestionErrorSchema,
  AskQuestionInteractionResponseSchema,
  AskQuestionResultSchema,
  CreatePlanErrorSchema,
  CreatePlanRequestResponseSchema,
  CreatePlanResultSchema,
  ExaFetchRequestResponseSchema,
  ExaFetchRequestResponse_ApprovedSchema,
  ExaFetchRequestResponse_RejectedSchema,
  ExaSearchRequestResponseSchema,
  ExaSearchRequestResponse_ApprovedSchema,
  ExaSearchRequestResponse_RejectedSchema,
  InteractionResponseSchema,
  SetupVmEnvironmentResultSchema,
  SetupVmEnvironmentSuccessSchema,
  SwitchModeRequestResponseSchema,
  SwitchModeRequestResponse_RejectedSchema,
  WebSearchRequestResponseSchema,
  WebSearchRequestResponse_ApprovedSchema,
  WebSearchRequestResponse_RejectedSchema,
  type InteractionQuery,
  type InteractionResponse,
} from "../proto/agent_pb.js";
import { encodeVarint } from "../proto/wire.js";
import { frameConnectMessage } from "../client/bridge.js";

const CURSOR_WEB_FETCH_INTERACTION_FIELD = 9;

const PI_REJECT_REASON =
  "Not available through the Pi Cursor provider. Use Pi tools (web_search, fetch, bash, etc.) instead.";

function encodeLengthDelimitedField(fieldNo: number, data: Uint8Array): number[] {
  return [(fieldNo << 3) | 2, ...encodeVarint(data.length), ...data];
}

/**
 * Field #9 is unnamed in the generated proto (web-fetch shaped). Approving it is
 * indistinguishable from granting a future destructive capability if Cursor reuses
 * the number, so we always reject. We still have to *answer* — `handled: false`
 * throws and kills the in-flight turn (#10).
 *
 * Wire shape mirrors ExaFetch/WebSearch: response oneof field 2 = rejected,
 * rejected.reason = 1.
 */
function buildCursorWebFetchInteractionRejectionBytes(id: number): Uint8Array {
  const reason = new TextEncoder().encode(PI_REJECT_REASON);
  const rejected = new Uint8Array(encodeLengthDelimitedField(1, reason));
  const result = new Uint8Array(encodeLengthDelimitedField(2, rejected));
  const interactionResponse = new Uint8Array([
    0x08,
    ...encodeVarint(id),
    ...encodeLengthDelimitedField(CURSOR_WEB_FETCH_INTERACTION_FIELD, result),
  ]);
  return new Uint8Array(encodeLengthDelimitedField(6, interactionResponse));
}

function hasUnknownInteractionField(query: InteractionQuery, fieldNo: number): boolean {
  return ((query as unknown as { $unknown?: Array<{ no: number }> }).$unknown ?? []).some(
    (field) => field.no === fieldNo,
  );
}

type InteractionDecision =
  | { kind: "webSearch" | "exaSearch" | "exaFetch"; approved: boolean }
  | { kind: "switchMode" | "askQuestion" | "createPlan" | "setupVm" };

type InteractionResult = InteractionResponse["result"];

function buildInteractionResult(decision: InteractionDecision): InteractionResult {
  switch (decision.kind) {
    case "webSearch":
      return {
        case: "webSearchRequestResponse",
        value: create(WebSearchRequestResponseSchema, {
          result: decision.approved
            ? {
                case: "approved",
                value: create(WebSearchRequestResponse_ApprovedSchema, {}),
              }
            : {
                case: "rejected",
                value: create(WebSearchRequestResponse_RejectedSchema, {
                  reason: PI_REJECT_REASON,
                }),
              },
        }),
      };
    case "exaSearch":
      return {
        case: "exaSearchRequestResponse",
        value: create(ExaSearchRequestResponseSchema, {
          result: decision.approved
            ? {
                case: "approved",
                value: create(ExaSearchRequestResponse_ApprovedSchema, {}),
              }
            : {
                case: "rejected",
                value: create(ExaSearchRequestResponse_RejectedSchema, {
                  reason: PI_REJECT_REASON,
                }),
              },
        }),
      };
    case "exaFetch":
      return {
        case: "exaFetchRequestResponse",
        value: create(ExaFetchRequestResponseSchema, {
          result: decision.approved
            ? {
                case: "approved",
                value: create(ExaFetchRequestResponse_ApprovedSchema, {}),
              }
            : {
                case: "rejected",
                value: create(ExaFetchRequestResponse_RejectedSchema, {
                  reason: PI_REJECT_REASON,
                }),
              },
        }),
      };
    case "switchMode":
      return {
        case: "switchModeRequestResponse",
        value: create(SwitchModeRequestResponseSchema, {
          result: {
            case: "rejected",
            value: create(SwitchModeRequestResponse_RejectedSchema, {
              reason: PI_REJECT_REASON,
            }),
          },
        }),
      };
    case "askQuestion":
      return {
        case: "askQuestionInteractionResponse",
        value: create(AskQuestionInteractionResponseSchema, {
          result: create(AskQuestionResultSchema, {
            result: {
              case: "error",
              value: create(AskQuestionErrorSchema, {
                errorMessage:
                  "Interactive questions are not available in Pi. Continue with a reasonable default or ask the user in chat.",
              }),
            },
          }),
        }),
      };
    case "createPlan":
      return {
        case: "createPlanRequestResponse",
        value: create(CreatePlanRequestResponseSchema, {
          result: create(CreatePlanResultSchema, {
            planUri: "",
            result: {
              case: "error",
              value: create(CreatePlanErrorSchema, {
                error: "Create-plan UI is not available in Pi. Write the plan with Pi file tools.",
              }),
            },
          }),
        }),
      };
    case "setupVm":
      return {
        case: "setupVmEnvironmentResult",
        value: create(SetupVmEnvironmentResultSchema, {
          result: {
            case: "success",
            value: create(SetupVmEnvironmentSuccessSchema, {}),
          },
        }),
      };
  }
}

function sendInteractionDecision(
  id: number,
  decision: InteractionDecision,
  sendFrame: (data: Uint8Array) => void,
): void {
  const response = create(InteractionResponseSchema, {
    id,
    result: buildInteractionResult(decision),
  });
  const clientMsg = create(AgentClientMessageSchema, {
    message: { case: "interactionResponse", value: response },
  });
  sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMsg)));
}

export type InteractionQueryHandleResult = {
  handled: boolean;
  action: string;
  queryCase: string | undefined;
};

/**
 * Always attempt to answer InteractionQuery so the upstream run does not park.
 * Web/search is rejected by default so Cursor-side fetches do not run under the
 * user's subscription; pass `{ approveWeb: true }` only in tests or explicit opt-in.
 */
export function handleInteractionQuery(
  query: InteractionQuery,
  sendFrame: (data: Uint8Array) => void,
  options?: { approveWeb?: boolean },
): InteractionQueryHandleResult {
  const approveWeb = options?.approveWeb === true;
  const queryCase = query.query.case;

  // Field #9 is unnamed in the generated proto. Approving it is indistinguishable
  // from granting a future destructive capability if Cursor reuses the number.
  // Reject with a real InteractionResponse so Cursor unblocks instead of parking,
  // and so processServerMessage does not throw and kill the turn (#10).
  if (hasUnknownInteractionField(query, CURSOR_WEB_FETCH_INTERACTION_FIELD)) {
    sendFrame(frameConnectMessage(buildCursorWebFetchInteractionRejectionBytes(query.id)));
    return {
      handled: true,
      action: "unknown_field_9_rejected",
      queryCase: queryCase ?? "unknown_field_9",
    };
  }

  switch (queryCase) {
    case "webSearchRequestQuery":
      sendInteractionDecision(query.id, { kind: "webSearch", approved: approveWeb }, sendFrame);
      return {
        handled: true,
        action: approveWeb ? "web_search_approved" : "web_search_rejected",
        queryCase,
      };
    case "exaSearchRequestQuery":
      sendInteractionDecision(query.id, { kind: "exaSearch", approved: approveWeb }, sendFrame);
      return {
        handled: true,
        action: approveWeb ? "exa_search_approved" : "exa_search_rejected",
        queryCase,
      };
    case "exaFetchRequestQuery":
      sendInteractionDecision(query.id, { kind: "exaFetch", approved: approveWeb }, sendFrame);
      return {
        handled: true,
        action: approveWeb ? "exa_fetch_approved" : "exa_fetch_rejected",
        queryCase,
      };
    case "switchModeRequestQuery":
      sendInteractionDecision(query.id, { kind: "switchMode" }, sendFrame);
      return { handled: true, action: "switch_mode_rejected", queryCase };
    case "askQuestionInteractionQuery":
      sendInteractionDecision(query.id, { kind: "askQuestion" }, sendFrame);
      return { handled: true, action: "ask_question_skipped", queryCase };
    case "createPlanRequestQuery":
      sendInteractionDecision(query.id, { kind: "createPlan" }, sendFrame);
      return { handled: true, action: "create_plan_skipped", queryCase };
    case "setupVmEnvironmentArgs":
      sendInteractionDecision(query.id, { kind: "setupVm" }, sendFrame);
      return { handled: true, action: "setup_vm_acked", queryCase };
    default: {
      // Protocol drift must fail closed. An empty result for an unknown field is
      // indistinguishable from approval and could grant a future destructive capability.
      const unknown = (query as unknown as { $unknown?: Array<{ no: number }> }).$unknown ?? [];
      if (unknown.length > 0) {
        const fieldNo = unknown[0]!.no;
        return {
          handled: false,
          action: `unknown_field_${fieldNo}_rejected`,
          queryCase: queryCase ?? "unknown",
        };
      }
      // No case and no unknown fields — still send a switch-mode-style reject is impossible.
      // Best effort: skip ask-question style is wrong. Log as unhandled.
      return { handled: false, action: "unhandled", queryCase: queryCase ?? "undefined" };
    }
  }
}
