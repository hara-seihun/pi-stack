import { expect, mock, test } from "bun:test";
import { proxyWebsocket, type ProxySocketData } from "./proxy-websocket";
import { PHONE_MAX_FRAME_BYTES } from "./phone-commands";

function peer() {
  return Object.assign(new EventTarget(), {
    readyState: Number(WebSocket.OPEN),
    bufferedAmount: 0,
    getBufferedAmount(): number { return this.bufferedAmount; },
    send: mock((_message: unknown, _compress?: boolean) => 1),
    close: mock(),
    terminate: mock(),
  });
}

// A loopback flood does not guarantee a stalled reader. Drive the actual
// transport callbacks with explicit queue occupancy instead of racing TCP.
test.each(["browser", "upstream"] as const)("WebSocket proxy drops at a stalled %s and resumes without replay", (direction) => {
  const upstream = peer();
  const browser = Object.assign(peer(), {
    data: { phone: false, upstream: upstream as unknown as WebSocket, signal: new AbortController().signal, closed: false },
  });
  const socket = browser as unknown as Bun.ServerWebSocket<ProxySocketData>;
  proxyWebsocket.open(socket);
  const target = direction === "browser" ? browser : upstream;
  const deliver = (message: string | Buffer<ArrayBuffer>) => {
    if (direction === "browser") {
      upstream.dispatchEvent(new MessageEvent("message", {
        data: typeof message === "string" ? message : new Uint8Array(message).buffer,
      }));
    } else proxyWebsocket.message(socket, message);
  };

  expect(proxyWebsocket.closeOnBackpressureLimit).toBe(false);
  for (const message of ["text", Buffer.from([1, 2, 3])]) {
    target.send.mockClear();
    target.bufferedAmount = 65_535;
    deliver(message);
    expect(target.send).toHaveBeenCalledTimes(1);
    const forwarded = target.send.mock.calls[0]![0];
    if (typeof message === "string") expect(forwarded).toBe(message);
    else expect(new Uint8Array(forwarded as ArrayBuffer)).toEqual(new Uint8Array(message));

    for (const queued of [65_536, 65_537]) {
      target.bufferedAmount = queued;
      for (let index = 0; index < 100; index++) deliver(message);
      expect(target.send).toHaveBeenCalledTimes(1);
    }
    target.bufferedAmount = 0;
    deliver("resumed");
    expect(target.send.mock.calls.map(call => call[0])).toEqual([forwarded, "resumed"]);
    expect(target.close).not.toHaveBeenCalled();
    expect(target.terminate).not.toHaveBeenCalled();
  }

  target.send.mockClear();
  for (const state of [WebSocket.CONNECTING, WebSocket.CLOSING, WebSocket.CLOSED]) {
    target.readyState = state;
    deliver("not open");
  }
  expect(target.send).not.toHaveBeenCalled();
});

test.each(["browser", "upstream"] as const)("phone proxy forwards beyond audio pressure and closes both peers at stalled %s", (direction) => {
  const upstream = peer();
  const browser = Object.assign(peer(), {
    data: { phone: true, upstream: upstream as unknown as WebSocket, signal: new AbortController().signal, closed: false },
  });
  const socket = browser as unknown as Bun.ServerWebSocket<ProxySocketData>;
  proxyWebsocket.open(socket);
  const target = direction === "browser" ? browser : upstream;
  const deliver = () => {
    if (direction === "browser") upstream.dispatchEvent(new MessageEvent("message", { data: "result" }));
    else proxyWebsocket.message(socket, "command");
  };

  expect(proxyWebsocket.backpressureLimit).toBe(PHONE_MAX_FRAME_BYTES);
  for (const queued of [65_536, PHONE_MAX_FRAME_BYTES - 1]) {
    target.bufferedAmount = queued;
    deliver();
  }
  expect(target.send).toHaveBeenCalledTimes(2);
  expect(browser.close).not.toHaveBeenCalled();
  expect(upstream.close).not.toHaveBeenCalled();

  target.bufferedAmount = PHONE_MAX_FRAME_BYTES;
  deliver();
  expect(target.send).toHaveBeenCalledTimes(2);
  expect(browser.close).toHaveBeenCalledWith(1011, "Phone backpressure exceeded");
  expect(upstream.close).toHaveBeenCalledWith(1011, "Phone backpressure exceeded");
});

test.each([0, -1])("phone proxy distinguishes failed send (%i) from queued delivery", (sent) => {
  const upstream = peer();
  const browser = Object.assign(peer(), {
    data: { phone: true, upstream: upstream as unknown as WebSocket, signal: new AbortController().signal, closed: false },
  });
  browser.send.mockReturnValue(sent);
  proxyWebsocket.open(browser as unknown as Bun.ServerWebSocket<ProxySocketData>);
  upstream.dispatchEvent(new MessageEvent("message", { data: "result" }));
  expect(browser.send).toHaveBeenCalledWith("result", false);
  for (const target of [browser, upstream]) {
    if (sent === 0) expect(target.close).toHaveBeenCalledWith(1011, "Phone forwarding failed");
    else expect(target.close).not.toHaveBeenCalled();
  }
});
