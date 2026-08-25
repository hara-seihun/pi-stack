package dev.piremote;

import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.annotation.SuppressLint;
import android.app.*;
import android.os.*;
import android.net.Uri;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.content.*;
import android.database.Cursor;
import android.provider.OpenableColumns;
import android.text.*;
import android.util.Log;
import android.text.style.*;
import android.view.*;
import android.view.inputmethod.InputMethodManager;
import android.widget.*;
import androidx.dynamicanimation.animation.DynamicAnimation;
import androidx.dynamicanimation.animation.SpringAnimation;
import io.noties.markwon.AbstractMarkwonPlugin;
import io.noties.markwon.LinkResolverDef;
import io.noties.markwon.Markwon;
import io.noties.markwon.MarkwonConfiguration;
import io.noties.markwon.ext.latex.JLatexMathPlugin;
import io.noties.markwon.ext.strikethrough.StrikethroughPlugin;
import io.noties.markwon.ext.tables.TablePlugin;
import io.noties.markwon.ext.tasklist.TaskListPlugin;
import io.noties.markwon.inlineparser.MarkwonInlineParserPlugin;
import io.noties.markwon.linkify.LinkifyPlugin;
import io.noties.markwon.image.glide.GlideImagesPlugin;
import io.noties.markwon.movement.MovementMethodPlugin;
import org.json.*;
import java.io.*;
import java.net.*;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.concurrent.*;

@SuppressLint("SetTextI18n")
public class MainActivity extends Activity {
    private static final int BG = Color.rgb(11, 13, 16);
    private static final int SURFACE = Color.rgb(22, 25, 30);
    private static final int SURFACE_2 = Color.rgb(31, 35, 42);
    private static final int TEXT = Color.rgb(241, 244, 248);
    private static final int MUTED = Color.rgb(139, 148, 158);
    private static final int ACCENT = Color.rgb(137, 180, 250);
    private static final int SUCCESS = Color.rgb(126, 231, 135);
    private static final int DANGER = Color.rgb(255, 123, 114);
    private static final int TOOL_PENDING = Color.rgb(40, 40, 50);
    private static final int TOOL_SUCCESS = Color.rgb(40, 50, 40);
    private static final int TOOL_ERROR = Color.rgb(55, 34, 36);
    private static final int DELEGATE = Color.rgb(203, 166, 247);
    private static final int DELEGATE_PENDING = Color.rgb(48, 38, 58);
    private static final int OPENAI = Color.rgb(16, 163, 127);
    private static final int OPUS = Color.rgb(124, 92, 191);
    private static final int ANTHROPIC = Color.rgb(217, 119, 87);
    private static final int WORK = Color.rgb(88, 101, 242);
    private static final int CONVERGE = Color.rgb(8, 145, 178);
    private static final int PERSONAL = Color.rgb(168, 85, 247);
    private static final int TOOL_PREVIEW_LINES = 5;
    private static final String THINKING = "**THINKING**\n\n";
    private static final int TOOL_HEADER_PREVIEW_LINES = 1;
    private static final String STATE_SESSION = "session";
    private static final String DRAFT_PREFS = "thread_drafts";
    private static final String DRAWER_PREFS = "drawer";
    private static final String DRAWER_TAB_KEY = "selected_tab";
    private static final String DRAWER_TAB_INTERACTIVE = "interactive";
    private static final String DRAWER_TAB_ORCHESTRATOR = "orchestrator";
    private static final String DRAWER_TAB_ARCHIVED = "archived";

    private Haptics haptics;
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private final ExecutorService abortNetwork = Executors.newSingleThreadExecutor();
    private final ExecutorService pollNetwork = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private LinearLayout drawer, settingsDrawer, planSummary;
    private View drawerScrim, settingsScrim, detail, emptyBox;
    private TextView connection, workAgentSummary, localAgentSummary, usageSummary, empty, topTitle, topState;
    private TextView settingsThread, settingsActivity, settingsCwd, queueStatus;
    private String machineUsageText = "CPU — · GPU — · RAM — · DISK —", machineUsageDescription = machineUsageText;
    private int machineUsageColor = MUTED;
    private LinearLayout transcript, attachmentList, messageQueueList, slashCommandList, composerBox;
    private LinearLayout drawerList, agentList, archivedList;
    private GooeyMenu threadStarter;
    private long transcriptOpenedMs;
    private boolean composerWasSending = true;
    private ScrollView drawerThreadScroll, drawerAgentScroll, drawerArchivedScroll;
    private TextView agentBanner;
    private DrawerTab interactiveTab, orchestratorTab, archivedTab;
    private LinearLayout drawerTabs;
    private Markwon markwon;
    private final MarkdownRasters rasters = new MarkdownRasters();
    /** The entry Pi is still writing, and the thought it is still having. Null when neither. */
    private Message liveAnswer;
    private MarkdownStream liveThought;
    private final Map<String, ToolCard> toolCards = new HashMap<>();
    private final Map<Long, TextView> userMessageLabels = new HashMap<>();
    private EditText prompt;
    private Button hamburger, settingsButton, actionButton, attachButton, pasteTextButton, voiceButton, modelButton, thinkingButton, speedButton;
    private ImageButton thunderButton, openAiGovernorButton, anthropicGovernorButton;
    private TranscriptScrollView transcriptScroll;
    private HorizontalScrollView attachmentScroll;
    private ScrollView messageQueueScroll;
    private final List<Attachment> attachments = new ArrayList<>();
    private long attachmentGeneration = 0;
    private String selectedId, selectedName = "Agent", selectedCwd = "/";
    private String selectedState = "STOPPED";
    private String selectedActivity = "IDLE", selectedTool = "";
    private int selectedSteeringQueued = 0, selectedFollowUpQueued = 0;
    private JSONArray selectedQueuedMessages = new JSONArray();
    private JSONArray availableCommands = new JSONArray();
    private long selectedRevision = 0, selectionGeneration = 0, actionGeneration = 0;
    private boolean refreshAgain = false;
    private final Map<String, Long> actionTokens = new HashMap<>();
    private final Map<String, String> actionTypes = new HashMap<>();
    private final Set<String> requestedCompletionWatches = new HashSet<>();
    private String openingThreadId;
    private JSONObject currentModel;
    private JSONArray availableModels = new JSONArray(), availableThinkingLevels = new JSONArray();
    private String currentThinkingLevel = "off", currentSpeedMode = "normal";
    private JSONArray availableSpeedModes = new JSONArray();
    private long lastSeq = 0;
    private boolean drawerOpen = false, settingsOpen = false, archiveSupported = false;
    private String drawerTab = DRAWER_TAB_INTERACTIVE;
    // The thread poll carries only the newest archived page; older pages load on request.
    private static final int ARCHIVED_PAGE_SIZE = 20;
    private JSONArray archivedOlder = new JSONArray();
    private int archivedTotal = 0;
    private boolean archivedOlderLoading = false;
    // The newest polled snapshot, so drawer-local changes redraw without waiting for a poll.
    private JSONArray lastSessions = new JSONArray(), lastArchivedPage = new JSONArray();
    // Read-only observation of autonomous orchestrator agents on every agent host.
    private JSONArray agentRuns = new JSONArray();
    private JSONArray agentHosts = new JSONArray();
    private int agentRunningCount = 0;
    private boolean agentHostFailing = false;
    private String agentError = "";
    private String agentRunId, agentRunLabel = "Agent", agentRunTask = "", agentRunStatus = "running";
    private String agentRunActivity = "WORKING", agentRunProvider = "";
    private long agentRunElapsedMs = 0;
    private boolean activityVisible = false;

    // Felt state: what the last haptic signalled, so only genuine changes are played.
    private boolean feltComposerArmed = false;
    private volatile boolean polling = false;
    private final Runnable poller = new Runnable() {
        public void run() { refresh(); main.postDelayed(this, 1200); }
    };
    private final Runnable openThreadHeartbeat = new Runnable() {
        public void run() {
            if (!activityVisible) return;
            publishOpenThread();
            main.postDelayed(this, OpenThreadVisibility.HEARTBEAT_INTERVAL_MS);
        }
    };

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        haptics = new Haptics(this);
        PiRemoteKey.attach(getApplicationContext());
        PiRemoteKey.setPrompter(this::askForKey);
        configureWindow();
        float markdownTextSize = 16f * getResources().getDisplayMetrics().scaledDensity;
        markwon = Markwon.builder(this)
            .usePlugin(MarkwonInlineParserPlugin.create())
            .usePlugin(LinkifyPlugin.create())
            .usePlugin(GlideImagesPlugin.create(this))
            .usePlugin(MovementMethodPlugin.link())
            .usePlugin(JLatexMathPlugin.create(markdownTextSize, builder -> {
                builder.inlinesEnabled(true);
                builder.theme().textColor(TEXT);
            }))
            .usePlugin(StrikethroughPlugin.create())
            .usePlugin(TablePlugin.create(this))
            .usePlugin(TaskListPlugin.create(this))
            .usePlugin(new AbstractMarkwonPlugin() {
                @Override public void configureConfiguration(MarkwonConfiguration.Builder builder) {
                    LinkResolverDef external = new LinkResolverDef();
                    builder.linkResolver((view, link) -> {
                        Uri uri = Uri.parse(link);
                        if (isPiRemoteFile(uri)) downloadFile(uri);
                        else external.resolve(view, link);
                    });
                }
            })
            .build();
        drawerTab = getSharedPreferences(DRAWER_PREFS, MODE_PRIVATE)
            .getString(DRAWER_TAB_KEY, DRAWER_TAB_INTERACTIVE);
        if (!DRAWER_TAB_INTERACTIVE.equals(drawerTab)
            && !DRAWER_TAB_ORCHESTRATOR.equals(drawerTab)
            && !DRAWER_TAB_ARCHIVED.equals(drawerTab)) drawerTab = DRAWER_TAB_INTERACTIVE;
        setContentView(buildUi());
        haptics.setAnchor(root);
        applyInsets();
        CompletionNotificationService.createChannels(this);
        String named = notificationTarget(getIntent());
        if (named == null && state != null) named = state.getString(STATE_SESSION);
        openNamedThread(named);
        android.content.SharedPreferences notificationPreferences =
            getSharedPreferences("completion_notifications", MODE_PRIVATE);
        if (Build.VERSION.SDK_INT >= 33
            && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED
            && !notificationPreferences.getBoolean("permission_requested", false)) {
            notificationPreferences.edit().putBoolean("permission_requested", true).apply();
            requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 42);
        }
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                () -> {
                    if (drawerOpen) closeDrawer();
                    else if (settingsOpen) closeSettings();
                    else finishAfterTransition();
                });
        }
        main.post(poller);
    }

    /**
     * An open thread-start menu is dismissed by touching anything else, before that touch does
     * whatever it would have done. A menu spread across the drawer's header is modal in every
     * way except this one, and leaving it open behind the next action is how it gets in the way.
     */
    @Override public boolean dispatchTouchEvent(MotionEvent event) {
        if (event.getActionMasked() == MotionEvent.ACTION_DOWN && threadStarter != null
            && threadStarter.dismissedBy(event.getRawX(), event.getRawY())) return true;
        return super.dispatchTouchEvent(event);
    }

    @Override protected void onStart() {
        super.onStart();
        haptics.refreshSystemSetting();
        haptics.setWatching(true);
        activityVisible = true;
        publishOpenThread();
        main.removeCallbacks(openThreadHeartbeat);
        main.postDelayed(openThreadHeartbeat, OpenThreadVisibility.HEARTBEAT_INTERVAL_MS);
    }

    @Override protected void onStop() {
        haptics.setWatching(false);
        activityVisible = false;
        main.removeCallbacks(openThreadHeartbeat);
        publishOpenThread();
        super.onStop();
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        if (selectedId != null) state.putString(STATE_SESSION, selectedId);
        saveDraft();
    }

    @Override public void onDestroy() {
        main.removeCallbacks(poller);
        main.removeCallbacks(openThreadHeartbeat);
        network.shutdownNow(); abortNetwork.shutdownNow(); pollNetwork.shutdownNow();
        super.onDestroy();
    }

    private void publishOpenThread() {
        CompletionNotificationService.setOpenThread(this, selectedId, activityVisible);
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        openNamedThread(notificationTarget(intent));
        refresh();
    }

    /**
     * Opens exactly the thread that was named, by asking the supervisor for that one thread.
     *
     * A tapped notification is a promise about a specific thread, so it cannot be served by
     * waiting for that thread to turn up in a drawer render: it may be archived, it may sit
     * beyond the loaded page, and on a cold start no list has arrived yet. Any of those left
     * the promise silently unkept, dropping the user on whichever thread was already there.
     * Asking for the thread by id keeps the promise in every one of those cases, and until it
     * is kept nothing else is allowed to take the screen.
     */
    private void openNamedThread(String id) { openNamedThread(id, 3); }

    private void openNamedThread(String id, int attemptsLeft) {
        if (id == null) return;
        if (id.equals(selectedId)) {
            CompletionNotificationService.clearCompletionNotification(this, id);
            return;
        }
        openingThreadId = id;
        long requestedSelectionGeneration = selectionGeneration;
        network.execute(() -> {
            try {
                JSONObject thread = api("GET", "/v1/sessions/" + id, null).getJSONObject("session");
                main.post(() -> {
                    if (!id.equals(openingThreadId)) return;
                    openingThreadId = null;
                    // A thread the user picked in the meantime outranks the one they tapped.
                    if (requestedSelectionGeneration != selectionGeneration) return;
                    CompletionNotificationService.clearCompletionNotification(this, id);
                    haptics.play(Haptics.Feel.THREAD_OPEN);
                    String state = thread.optString("state", "STOPPED");
                    select(thread.optString("id"), thread.optString("name", "Agent"),
                        thread.optString("cwd", "/"), state,
                        thread.optString("activity", activityFromState(state)),
                        thread.optString("activeTool", ""), thread.optLong("revision"),
                        thread.optInt("steeringQueued"), thread.optInt("followUpQueued"),
                        thread.optJSONArray("queuedMessages"));
                });
            } catch (Exception failure) {
                Log.w("PiRemote", "Could not open thread " + id, failure);
                boolean gone = isMissing(failure);
                main.post(() -> {
                    if (!id.equals(openingThreadId)) return;
                    // A thread that is merely unreachable is worth waiting for; a deleted one is not.
                    if (gone || attemptsLeft <= 0) { openingThreadId = null; return; }
                    main.postDelayed(() -> openNamedThread(id, attemptsLeft - 1), 1500);
                });
            }
        });
    }

    /**
     * A tapped notification names its thread once. The extra is taken out of the intent as it
     * is read, because the intent outlives the tap: it is still the activity's intent after a
     * rotation or a recreation, and replaying it would drag the user back out of whatever they
     * opened next.
     */
    private String notificationTarget(Intent intent) {
        if (intent == null) return null;
        String id = intent.getStringExtra(CompletionNotificationService.EXTRA_SESSION_ID);
        if (id != null) intent.removeExtra(CompletionNotificationService.EXTRA_SESSION_ID);
        return id;
    }

    @SuppressLint("GestureBackNavigation")
    @Override public void onBackPressed() {
        if (drawerOpen) closeDrawer();
        else if (settingsOpen) closeSettings();
        else super.onBackPressed();
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != 41 || resultCode != RESULT_OK || data == null) return;
        if (data.getClipData() != null) {
            ClipData clip = data.getClipData();
            for (int i = 0; i < clip.getItemCount(); i++) queueAttachment(clip.getItemAt(i).getUri());
        } else if (data.getData() != null) queueAttachment(data.getData());
    }

    private boolean isPiRemoteFile(Uri uri) {
        Uri server = Uri.parse(BuildConfig.SERVER_URL);
        String path = uri.getPath();
        return Objects.equals(server.getScheme(), uri.getScheme())
            && Objects.equals(server.getAuthority(), uri.getAuthority())
            && path != null
            && path.matches("/v1/sessions/[0-9a-fA-F-]+/files");
    }

    private void downloadFile(Uri uri) {
        String path = uri.getQueryParameter("path");
        String name = path == null ? "Download" : new File(path).getName();
        if (name.isBlank()) name = "Download";
        try {
            DownloadManager.Request request = new DownloadManager.Request(uri)
                .setTitle(name)
                .setDescription("Pi Remote file")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            DownloadManager manager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            manager.enqueue(request);
            Toast.makeText(this, "Downloading " + name, Toast.LENGTH_SHORT).show();
        } catch (RuntimeException failure) {
            Toast.makeText(this, "Could not download " + name, Toast.LENGTH_LONG).show();
        }
    }

    private void configureWindow() {
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        getWindow().getDecorView().setSystemUiVisibility(0);
    }

    private void applyInsets() {
        if (Build.VERSION.SDK_INT >= 30) {
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
                return insets;
            });
            root.requestApplyInsets();
        } else root.setFitsSystemWindows(true);
    }

    private int dp(int n) { return Math.round(n * getResources().getDisplayMetrics().density); }

    private GradientDrawable shape(int color) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(0);
        return d;
    }

    private GradientDrawable outlined(int color, int strokeColor) {
        GradientDrawable d = shape(color);
        d.setStroke(dp(1), strokeColor);
        return d;
    }

    private TextView text(String value, int size, boolean bold) {
        TextView v = new TextView(this);
        v.setText(value); v.setTextSize(size); v.setTextColor(TEXT);
        v.setGravity(Gravity.CENTER_VERTICAL);
        if (bold) v.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return v;
    }

    private void makeSelectable(TextView view) {
        view.setTextIsSelectable(true);
        view.setLongClickable(true);
    }

    private MarkdownStream markdown(int size, int color) {
        MarkdownStream view = new MarkdownStream(this, markwon, rasters, selectedId);
        view.setTextSize(size); view.setTextColor(color); view.setGravity(Gravity.TOP);
        return view;
    }

    private ImageButton iconButton(int drawable, String description) {
        ImageButton button = new ImageButton(this);
        button.setImageResource(drawable);
        button.setContentDescription(description);
        button.setColorFilter(MUTED);
        button.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        button.setPadding(dp(12), dp(12), dp(12), dp(12));
        button.setMinimumHeight(0); button.setMinimumWidth(0);
        button.setBackground(shape(SURFACE_2));
        button.setStateListAnimator(null);
        haptics.arm(button);
        return button;
    }

    private Button button(String label, boolean accent) {
        Button b = new Button(this);
        b.setText(label); b.setAllCaps(false); b.setTextSize(14);
        b.setTextColor(accent ? BG : TEXT);
        b.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        b.setPadding(dp(14), 0, dp(14), 0);
        b.setMinHeight(0); b.setMinimumHeight(0); b.setMinWidth(0); b.setMinimumWidth(0);
        b.setBackground(shape(accent ? ACCENT : SURFACE_2));
        b.setStateListAnimator(null);
        haptics.arm(b);
        return b;
    }

    /** A drawer tab: the glyph for what it lists, and how many are in there. */
    private static final class DrawerTab {
        final FrameLayout root;
        final ImageView glyph;
        final TextView count;

        DrawerTab(FrameLayout root, ImageView glyph, TextView count) {
            this.root = root; this.glyph = glyph; this.count = count;
        }
    }

    private DrawerTab drawerTabButton(int drawable, String label, String tab) {
        FrameLayout root = new FrameLayout(this);
        ImageView glyph = new ImageView(this);
        glyph.setImageResource(drawable);
        glyph.setScaleType(ImageView.ScaleType.FIT_CENTER);
        int inset = dp(12);
        glyph.setPadding(inset, inset, inset, inset);
        root.addView(glyph, new FrameLayout.LayoutParams(-1, -1));
        // The word is gone, but the number is not a word, and it is the live part.
        TextView count = new TextView(this);
        count.setTextSize(9); count.setTypeface(null, Typeface.BOLD);
        count.setGravity(Gravity.CENTER);
        FrameLayout.LayoutParams badge = new FrameLayout.LayoutParams(-2, -2, Gravity.END | Gravity.TOP);
        badge.setMargins(0, dp(3), dp(3), 0);
        root.addView(count, badge);
        root.setOnClickListener(view -> selectDrawerTab(tab));
        haptics.arm(root);
        return new DrawerTab(root, glyph, count);
    }

    private void selectDrawerTab(String tab) {
        if (!DRAWER_TAB_INTERACTIVE.equals(tab)
            && !DRAWER_TAB_ORCHESTRATOR.equals(tab)
            && !DRAWER_TAB_ARCHIVED.equals(tab)) return;
        if (!tab.equals(drawerTab)) haptics.play(Haptics.Feel.TAB);
        if (!DRAWER_TAB_ARCHIVED.equals(tab)) archivedOlder = new JSONArray();
        drawerTab = tab;
        getSharedPreferences(DRAWER_PREFS, MODE_PRIVATE).edit().putString(DRAWER_TAB_KEY, tab).apply();
        renderDrawerTabs();
        redrawSessions();
        renderAgentSection();
        if (DRAWER_TAB_ORCHESTRATOR.equals(tab)) refresh();
    }

    private void renderDrawerTab(DrawerTab tab, String label, int count, boolean selected, boolean attention) {
        int ink = selected ? TEXT : attention ? DANGER : MUTED;
        tab.glyph.setColorFilter(ink);
        tab.count.setText(count > 0 ? String.valueOf(count) : "");
        tab.count.setTextColor(ink);
        // Only the tab you are on is drawn as a thing; the others are just their glyphs.
        tab.root.setBackground(shape(selected ? SURFACE_2 : Color.TRANSPARENT));
        // The tab that just took over swells a little, so the eye follows the change.
        if (selected != tab.root.isSelected())
            Springs.scale(tab.root, selected ? 1.08f : 1f, Springs.POP_STIFFNESS, 0.4f);
        tab.root.setSelected(selected);
        // The glyph carries the meaning by sight; the label still exists for anyone listening.
        tab.root.setContentDescription(label + ", " + count + (attention ? ", a host is unreachable" : "")
            + (selected ? ", selected" : ""));
    }

    private void renderDrawerTabs() {
        if (interactiveTab == null) return;
        boolean failing = agentHostFailing || !agentError.isEmpty();
        int archivedCount = Math.max(archivedTotal, loadedArchived(lastArchivedPage).size());
        renderDrawerTab(interactiveTab, "Interactive", lastSessions.length(),
            DRAWER_TAB_INTERACTIVE.equals(drawerTab), false);
        renderDrawerTab(orchestratorTab, "Orchestrator", agentRunningCount,
            DRAWER_TAB_ORCHESTRATOR.equals(drawerTab), failing);
        renderDrawerTab(archivedTab, "Archived", archivedCount,
            DRAWER_TAB_ARCHIVED.equals(drawerTab), false);
        drawerThreadScroll.setVisibility(DRAWER_TAB_INTERACTIVE.equals(drawerTab) ? View.VISIBLE : View.GONE);
        drawerAgentScroll.setVisibility(DRAWER_TAB_ORCHESTRATOR.equals(drawerTab) ? View.VISIBLE : View.GONE);
        drawerArchivedScroll.setVisibility(DRAWER_TAB_ARCHIVED.equals(drawerTab) ? View.VISIBLE : View.GONE);
    }

    private View buildUi() {
        root = new FrameLayout(this);
        root.setBackgroundColor(BG);

        FrameLayout mainPane = new FrameLayout(this);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);

        LinearLayout topBar = new LinearLayout(this);
        topBar.setGravity(Gravity.CENTER_VERTICAL);
        topBar.setPadding(0, 0, 0, 0);
        topBar.setBackground(outlined(SURFACE, SURFACE_2));
        hamburger = button("☰", false);
        hamburger.setTextSize(22); hamburger.setContentDescription("Open agents drawer");
        hamburger.setOnClickListener(v -> openDrawer());
        topBar.addView(hamburger, new LinearLayout.LayoutParams(dp(52), dp(56)));
        topTitle = text("Pi Remote", 16, true);
        topTitle.setSingleLine(true); topTitle.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(0, dp(56), 1);
        titleParams.leftMargin = dp(12); titleParams.rightMargin = dp(8);
        topBar.addView(topTitle, titleParams);
        topState = text("IDLE", 12, true);
        topState.setTextColor(MUTED); topState.setGravity(Gravity.CENTER_VERTICAL | Gravity.END);
        topState.setSingleLine(true); topState.setMaxWidth(dp(190)); topState.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams stateParams = new LinearLayout.LayoutParams(-2, dp(56));
        stateParams.leftMargin = dp(8); stateParams.rightMargin = dp(12);
        topBar.addView(topState, stateParams);
        settingsButton = button("⚙", false);
        settingsButton.setTextSize(20); settingsButton.setContentDescription("Open thread settings");
        settingsButton.setOnClickListener(v -> openSettings());
        topBar.addView(settingsButton, new LinearLayout.LayoutParams(dp(48), dp(56)));
        content.addView(topBar, new LinearLayout.LayoutParams(-1, dp(56)));

        detail = buildDetail();
        detail.setVisibility(View.GONE);
        content.addView(detail, new LinearLayout.LayoutParams(-1, 0, 1));

        emptyBox = new LinearLayout(this);
        ((LinearLayout) emptyBox).setOrientation(LinearLayout.VERTICAL);
        ((LinearLayout) emptyBox).setGravity(Gravity.CENTER);
        empty = text("No threads", 22, true); empty.setGravity(Gravity.CENTER);
        TextView hint = text("Open the drawer to create one.", 15, false);
        hint.setTextColor(MUTED); hint.setGravity(Gravity.CENTER); hint.setPadding(0, dp(8), 0, 0);
        ((LinearLayout) emptyBox).addView(empty); ((LinearLayout) emptyBox).addView(hint);
        content.addView(emptyBox, new LinearLayout.LayoutParams(-1, 0, 1));
        mainPane.addView(content, new FrameLayout.LayoutParams(-1, -1));
        root.addView(mainPane, new FrameLayout.LayoutParams(-1, -1));

        drawerScrim = new View(this);
        drawerScrim.setBackgroundColor(Color.argb(175, 0, 0, 0));
        drawerScrim.setVisibility(View.GONE);
        drawerScrim.setOnClickListener(v -> { haptics.play(Haptics.Feel.DISMISS); closeDrawer(); });
        root.addView(drawerScrim, new FrameLayout.LayoutParams(-1, -1));

        drawer = buildDrawer();
        int drawerWidth = Math.min(dp(340), getResources().getDisplayMetrics().widthPixels - dp(44));
        FrameLayout.LayoutParams drawerParams = new FrameLayout.LayoutParams(drawerWidth, -1, Gravity.START);
        drawer.setVisibility(View.GONE);
        root.addView(drawer, drawerParams);

        settingsScrim = new View(this);
        settingsScrim.setBackgroundColor(Color.argb(175, 0, 0, 0));
        settingsScrim.setVisibility(View.GONE);
        settingsScrim.setOnClickListener(v -> { haptics.play(Haptics.Feel.DISMISS); closeSettings(); });
        root.addView(settingsScrim, new FrameLayout.LayoutParams(-1, -1));

        settingsDrawer = buildSettingsDrawer();
        FrameLayout.LayoutParams settingsParams = new FrameLayout.LayoutParams(drawerWidth, -1, Gravity.END);
        settingsDrawer.setVisibility(View.GONE);
        root.addView(settingsDrawer, settingsParams);
        return root;
    }

    private View buildDetail() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);

        // One list, in the order things happened, whose last entry may still be growing.
        transcript = new LinearLayout(this);
        transcript.setOrientation(LinearLayout.VERTICAL);
        transcript.setPadding(dp(16), dp(16), dp(16), dp(14));
        transcript.setBackgroundColor(BG);
        transcriptScroll = new TranscriptScrollView(this);
        transcriptScroll.setFillViewport(true); transcriptScroll.setBackgroundColor(BG);
        transcriptScroll.addView(transcript);
        boolean[] transcriptAtEdge = { false };
        transcriptScroll.setScrollListener((scrollY, previousScrollY, atEnd, atStart) ->
            feelScroll(Math.abs(scrollY - previousScrollY), atEnd || atStart, transcriptAtEdge));
        box.addView(transcriptScroll, new LinearLayout.LayoutParams(-1, 0, 1));

        queueStatus = text("", 11, true); queueStatus.setTextColor(MUTED);
        queueStatus.setPadding(dp(11), dp(6), dp(11), dp(6)); queueStatus.setBackgroundColor(SURFACE);
        queueStatus.setVisibility(View.GONE);
        box.addView(queueStatus, new LinearLayout.LayoutParams(-1, -2));

        messageQueueList = new LinearLayout(this); messageQueueList.setOrientation(LinearLayout.VERTICAL);
        messageQueueScroll = new ScrollView(this); messageQueueScroll.setBackgroundColor(SURFACE);
        messageQueueScroll.setVisibility(View.GONE); messageQueueScroll.addView(messageQueueList);
        box.addView(messageQueueScroll, new LinearLayout.LayoutParams(-1, dp(160)));

        attachmentList = new LinearLayout(this); attachmentList.setOrientation(LinearLayout.HORIZONTAL);
        attachmentList.setPadding(dp(8), dp(6), dp(8), dp(6));
        attachmentScroll = new HorizontalScrollView(this); attachmentScroll.setHorizontalScrollBarEnabled(false);
        attachmentScroll.setBackground(outlined(SURFACE, SURFACE_2)); attachmentScroll.setVisibility(View.GONE);
        attachmentScroll.addView(attachmentList, new HorizontalScrollView.LayoutParams(-2, -2));
        box.addView(attachmentScroll, new LinearLayout.LayoutParams(-1, -2));

        agentBanner = text("", 12, true); agentBanner.setTextColor(MUTED);
        agentBanner.setPadding(dp(12), dp(9), dp(12), dp(9)); agentBanner.setBackgroundColor(SURFACE);
        agentBanner.setVisibility(View.GONE);
        box.addView(agentBanner, new LinearLayout.LayoutParams(-1, -2));

        LinearLayout composer = new LinearLayout(this);
        composerBox = composer;
        composer.setOrientation(LinearLayout.VERTICAL);
        composer.setPadding(dp(5), dp(4), dp(5), dp(5));
        composer.setBackground(outlined(SURFACE, SURFACE_2));
        slashCommandList = new LinearLayout(this);
        slashCommandList.setOrientation(LinearLayout.VERTICAL);
        slashCommandList.setBackgroundColor(SURFACE_2);
        slashCommandList.setVisibility(View.GONE);
        composer.addView(slashCommandList, new LinearLayout.LayoutParams(-1, -2));
        prompt = new EditText(this);
        prompt.setHint("Message agent · it can delegate tasks"); prompt.setHintTextColor(MUTED);
        prompt.setTextColor(TEXT); prompt.setTextSize(16); prompt.setBackgroundColor(Color.TRANSPARENT);
        prompt.setPadding(dp(10), dp(7), dp(10), dp(7));
        // setSingleLine(false) resets TextView's line limit, so it must precede setMaxLines.
        // Otherwise a large multiline paste can grow over the action row and hide Send.
        prompt.setSingleLine(false); prompt.setMaxLines(5);
        prompt.setVerticalScrollBarEnabled(true); prompt.setGravity(Gravity.TOP | Gravity.START);
        prompt.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_SEND);
        prompt.setOnEditorActionListener((v, action, event) -> {
            if (action == android.view.inputmethod.EditorInfo.IME_ACTION_SEND) {
                if (!prompt.getText().toString().trim().isEmpty() || hasReadyAttachments())
                    sendPrompt("followUp");
                return true;
            }
            return false;
        });
        prompt.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            public void onTextChanged(CharSequence s, int start, int before, int count) { updateComposer(); }
            public void afterTextChanged(Editable s) { saveDraft(); }
        });
        // The keyboard shrinking the viewport is a layout change, and following handles it.
        composer.addView(prompt, new LinearLayout.LayoutParams(-1, -2));
        LinearLayout actions = new LinearLayout(this); actions.setGravity(Gravity.CENTER_VERTICAL);
        attachButton = button("", false); attachButton.setBackgroundColor(Color.TRANSPARENT);
        attachButton.setPadding(dp(9), 0, dp(9), 0); attachButton.setCompoundDrawablesWithIntrinsicBounds(R.drawable.ic_attach, 0, 0, 0);
        attachButton.setContentDescription("Attach files"); attachButton.setOnClickListener(v -> openFilePicker());
        actions.addView(attachButton, new LinearLayout.LayoutParams(dp(40), dp(40)));
        pasteTextButton = button("", false); pasteTextButton.setBackgroundColor(Color.TRANSPARENT);
        pasteTextButton.setPadding(dp(9), 0, dp(9), 0); pasteTextButton.setCompoundDrawablesWithIntrinsicBounds(R.drawable.ic_paste_text, 0, 0, 0);
        pasteTextButton.setContentDescription("Paste text document"); pasteTextButton.setOnClickListener(v -> showPasteTextDialog());
        actions.addView(pasteTextButton, new LinearLayout.LayoutParams(dp(40), dp(40)));
        actions.addView(new View(this), new LinearLayout.LayoutParams(0, dp(1), 1));
        voiceButton = button("", false); voiceButton.setBackgroundColor(Color.TRANSPARENT);
        voiceButton.setPadding(dp(9), 0, dp(9), 0); voiceButton.setCompoundDrawablesWithIntrinsicBounds(R.drawable.ic_voice, 0, 0, 0);
        voiceButton.setContentDescription("Start voice"); voiceButton.setOnClickListener(v -> openVoice());
        actions.addView(voiceButton, new LinearLayout.LayoutParams(dp(40), dp(40)));
        actionButton = button("", true); actionButton.setPadding(dp(9), 0, dp(9), 0);
        actionButton.setCompoundDrawablesWithIntrinsicBounds(R.drawable.ic_send, 0, 0, 0);
        actionButton.setContentDescription("Send message");
        actionButton.setOnClickListener(v -> {
            if (!prompt.getText().toString().trim().isEmpty() || hasReadyAttachments()) sendPrompt("followUp");
            else if (isWorking(selectedState)) abortSelected();
        });
        actions.addView(actionButton, new LinearLayout.LayoutParams(dp(40), dp(40)));
        composer.addView(actions, new LinearLayout.LayoutParams(-1, dp(40)));
        box.addView(composer);
        return box;
    }

    /**
     * The grain of a moving list, plus a soft landing when it runs out of travel. Driven only
     * by scrolls the user caused: a list that re-lays out under a poll has not moved for them.
     */
    private void installScrollTexture(ScrollView scroll) {
        boolean[] atEdge = { false };
        boolean[] touching = { false };
        scroll.setOnTouchListener((view, event) -> {
            int action = event.getActionMasked();
            // A list row consumes the press, so the drag itself is the reliable signal here.
            if (action == MotionEvent.ACTION_DOWN || action == MotionEvent.ACTION_MOVE) touching[0] = true;
            else if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL)
                view.postDelayed(() -> touching[0] = false, 250);
            return false;
        });
        scroll.setOnScrollChangeListener((view, scrollX, scrollY, oldScrollX, oldScrollY) -> {
            View child = scroll.getChildAt(0);
            if (child == null || !touching[0]) return;
            int end = Math.max(0, child.getHeight() - scroll.getHeight());
            feelScroll(Math.abs(scrollY - oldScrollY), scrollY <= 0 || scrollY >= end, atEdge);
        });
    }

    private void feelScroll(int travelled, boolean atEnd, boolean[] wasAtEdge) {
        haptics.scrolled(travelled, dp(56));
        if (atEnd && !wasAtEdge[0]) haptics.play(Haptics.Feel.EDGE);
        wasAtEdge[0] = atEnd;
    }

    private LinearLayout buildDrawer() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL); panel.setBackgroundColor(SURFACE);

        // One button holds every way to start a thread; it splits into them when asked.
        // The tabs and the new-thread button share one row, because they are the same row: the
        // button takes the whole of it when it divides, and the tabs step aside while it has it.
        FrameLayout heading = new FrameLayout(this);
        heading.setClipChildren(false); heading.setClipToPadding(false);
        heading.setPadding(dp(8), dp(6), dp(8), dp(6));
        drawerTabs = new LinearLayout(this);
        drawerTabs.setOrientation(LinearLayout.HORIZONTAL);
        interactiveTab = drawerTabButton(R.drawable.ic_tab_interactive, "Interactive", DRAWER_TAB_INTERACTIVE);
        orchestratorTab = drawerTabButton(R.drawable.ic_tab_orchestrator, "Orchestrator", DRAWER_TAB_ORCHESTRATOR);
        archivedTab = drawerTabButton(R.drawable.ic_tab_archived, "Archived", DRAWER_TAB_ARCHIVED);
        for (DrawerTab tab : new DrawerTab[]{ interactiveTab, orchestratorTab, archivedTab }) {
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(dp(50), dp(44));
            params.rightMargin = dp(6);
            drawerTabs.addView(tab.root, params);
        }
        heading.addView(drawerTabs, new FrameLayout.LayoutParams(-2, -1, Gravity.START | Gravity.CENTER_VERTICAL));
        threadStarter = new GooeyMenu(this, haptics, ACCENT);
        threadStarter.setOnStart(this::newThread);
        // Nothing else may sit under the liquid while it is spread across the row.
        threadStarter.setOnExpansion(expanded -> {
            Springs.to(drawerTabs, DynamicAnimation.ALPHA, expanded ? 0f : 1f, Springs.POP_STIFFNESS, 1f);
            Springs.scale(drawerTabs, expanded ? 0.8f : 1f, Springs.POP_STIFFNESS, expanded ? 1f : 0.55f);
            for (DrawerTab tab : new DrawerTab[]{ interactiveTab, orchestratorTab, archivedTab })
                tab.root.setClickable(!expanded);
        });
        heading.addView(threadStarter, new FrameLayout.LayoutParams(-1, -1));
        // Above the thread list, so a choice dropping out of the row is seen falling past it
        // rather than disappearing under it the instant it leaves the row.
        heading.setTranslationZ(dp(1));
        panel.setClipChildren(false);
        panel.addView(heading, new LinearLayout.LayoutParams(-1, dp(56)));

        drawerList = new LinearLayout(this); drawerList.setOrientation(LinearLayout.VERTICAL);
        drawerThreadScroll = new ScrollView(this); drawerThreadScroll.setFillViewport(true); drawerThreadScroll.addView(drawerList);
        agentList = new LinearLayout(this); agentList.setOrientation(LinearLayout.VERTICAL);
        drawerAgentScroll = new ScrollView(this); drawerAgentScroll.setFillViewport(true); drawerAgentScroll.addView(agentList);
        archivedList = new LinearLayout(this); archivedList.setOrientation(LinearLayout.VERTICAL);
        drawerArchivedScroll = new ScrollView(this); drawerArchivedScroll.setFillViewport(true); drawerArchivedScroll.addView(archivedList);
        for (ScrollView page : new ScrollView[]{ drawerThreadScroll, drawerAgentScroll, drawerArchivedScroll })
            installScrollTexture(page);
        FrameLayout pages = new FrameLayout(this);
        pages.addView(drawerThreadScroll, new FrameLayout.LayoutParams(-1, -1));
        pages.addView(drawerAgentScroll, new FrameLayout.LayoutParams(-1, -1));
        pages.addView(drawerArchivedScroll, new FrameLayout.LayoutParams(-1, -1));
        panel.addView(pages, new LinearLayout.LayoutParams(-1, 0, 1));
        renderDrawerTabs();

        LinearLayout footer = new LinearLayout(this);
        footer.setOrientation(LinearLayout.VERTICAL); footer.setPadding(dp(18), dp(8), dp(18), dp(8));
        footer.setBackground(outlined(SURFACE, SURFACE_2));
        LinearLayout machineControls = new LinearLayout(this);
        machineControls.setOrientation(LinearLayout.HORIZONTAL);
        machineControls.setGravity(Gravity.CENTER);
        thunderButton = iconButton(R.drawable.ic_thunder, "Toggle thunder sounds on this machine");
        thunderButton.setOnClickListener(v -> toggleThunder());
        openAiGovernorButton = iconButton(R.drawable.ic_openai, "Cycle OpenAI governor allowance on this machine");
        openAiGovernorButton.setOnClickListener(v -> toggleGovernor("openai", openAiGovernorButton));
        anthropicGovernorButton = iconButton(R.drawable.ic_anthropic, "Cycle Anthropic governor allowance on this machine");
        anthropicGovernorButton.setOnClickListener(v -> toggleGovernor("anthropic", anthropicGovernorButton));
        for (ImageButton control : new ImageButton[] { thunderButton, openAiGovernorButton, anthropicGovernorButton }) {
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dp(44), 1);
            params.setMarginStart(dp(2)); params.setMarginEnd(dp(2));
            machineControls.addView(control, params);
        }
        footer.addView(machineControls, new LinearLayout.LayoutParams(-1, dp(44)));
        LinearLayout workAgentRow = new LinearLayout(this); workAgentRow.setGravity(Gravity.CENTER_VERTICAL);
        ImageView workAgentIcon = new ImageView(this); workAgentIcon.setImageResource(R.drawable.ic_work); workAgentIcon.setAlpha(0.72f);
        workAgentRow.addView(workAgentIcon, new LinearLayout.LayoutParams(dp(14), dp(14)));
        workAgentSummary = text("—", 11, true); workAgentSummary.setTextColor(MUTED);
        workAgentSummary.setSingleLine(true); workAgentSummary.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams workAgentTextParams = new LinearLayout.LayoutParams(0, dp(28), 1);
        workAgentTextParams.leftMargin = dp(7); workAgentRow.addView(workAgentSummary, workAgentTextParams);
        footer.addView(workAgentRow, new LinearLayout.LayoutParams(-1, dp(28)));
        LinearLayout localAgentRow = new LinearLayout(this); localAgentRow.setGravity(Gravity.CENTER_VERTICAL);
        ImageView localAgentIcon = new ImageView(this); localAgentIcon.setImageResource(R.drawable.ic_personal); localAgentIcon.setAlpha(0.72f);
        localAgentRow.addView(localAgentIcon, new LinearLayout.LayoutParams(dp(14), dp(14)));
        localAgentSummary = text("—", 11, true); localAgentSummary.setTextColor(MUTED);
        localAgentSummary.setSingleLine(true); localAgentSummary.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams localAgentTextParams = new LinearLayout.LayoutParams(0, dp(28), 1);
        localAgentTextParams.leftMargin = dp(7); localAgentRow.addView(localAgentSummary, localAgentTextParams);
        footer.addView(localAgentRow, new LinearLayout.LayoutParams(-1, dp(28)));
        planSummary = new LinearLayout(this); planSummary.setOrientation(LinearLayout.VERTICAL);
        footer.addView(planSummary, new LinearLayout.LayoutParams(-1, -2));
        usageSummary = text("CPU — · GPU — · RAM — · DISK —", 11, true); usageSummary.setTextColor(MUTED);
        usageSummary.setSingleLine(true); usageSummary.setEllipsize(TextUtils.TruncateAt.END);
        footer.addView(usageSummary, new LinearLayout.LayoutParams(-1, dp(32)));
        connection = text("", 12, true); connection.setTextColor(MUTED); connection.setVisibility(View.GONE);
        footer.addView(connection, new LinearLayout.LayoutParams(-1, dp(28)));
        panel.addView(footer, new LinearLayout.LayoutParams(-1, -2));
        return panel;
    }

    private TextView settingsLabel(String value) {
        TextView label = text(value.toUpperCase(Locale.ROOT), 11, true);
        label.setTextColor(MUTED); label.setPadding(0, dp(18), 0, dp(6));
        return label;
    }

    private LinearLayout buildSettingsDrawer() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL); panel.setBackgroundColor(SURFACE);

        LinearLayout heading = new LinearLayout(this);
        heading.setGravity(Gravity.CENTER_VERTICAL); heading.setPadding(dp(18), dp(8), dp(8), dp(8));
        TextView title = text("Thread settings", 22, true);
        heading.addView(title, new LinearLayout.LayoutParams(0, dp(52), 1));
        Button close = button("×", false); close.setTextSize(20); close.setContentDescription("Close thread settings");
        close.setOnClickListener(v -> closeSettings());
        heading.addView(close, new LinearLayout.LayoutParams(dp(44), dp(44)));
        panel.addView(heading);

        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL); body.setPadding(dp(18), 0, dp(18), dp(20));
        body.addView(settingsLabel("Thread"));
        settingsThread = text("—", 16, true); body.addView(settingsThread, new LinearLayout.LayoutParams(-1, dp(44)));
        body.addView(settingsLabel("Activity"));
        settingsActivity = text("IDLE", 14, true); settingsActivity.setTextColor(MUTED);
        body.addView(settingsActivity, new LinearLayout.LayoutParams(-1, dp(44)));
        body.addView(settingsLabel("Model"));
        modelButton = button("Loading…", false); modelButton.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        modelButton.setContentDescription("Change model"); modelButton.setOnClickListener(v -> showModelPicker());
        body.addView(modelButton, new LinearLayout.LayoutParams(-1, dp(56)));
        body.addView(settingsLabel("Thinking level"));
        thinkingButton = button("Loading…", false); thinkingButton.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        thinkingButton.setContentDescription("Change thinking level"); thinkingButton.setOnClickListener(v -> showThinkingPicker());
        body.addView(thinkingButton, new LinearLayout.LayoutParams(-1, dp(52)));
        body.addView(settingsLabel("Speed mode"));
        speedButton = button("Loading…", false); speedButton.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        speedButton.setContentDescription("Change speed mode"); speedButton.setOnClickListener(v -> showSpeedPicker());
        body.addView(speedButton, new LinearLayout.LayoutParams(-1, dp(52)));
        body.addView(settingsLabel("Working directory"));
        settingsCwd = text("/", 14, false); settingsCwd.setTextColor(MUTED);
        body.addView(settingsCwd, new LinearLayout.LayoutParams(-1, dp(44)));

        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true); scroll.addView(body);
        panel.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        return panel;
    }

    private void renderIconToggle(ImageButton button, boolean active, String activeDescription, String inactiveDescription) {
        button.setColorFilter(active ? SUCCESS : MUTED);
        button.setBackground(shape(active ? TOOL_SUCCESS : SURFACE_2));
        button.setContentDescription(active ? activeDescription : inactiveDescription);
        button.setSelected(active);
        button.setEnabled(true);
    }

    private void renderThunderStatus(JSONObject thunder) {
        boolean active = thunder != null && thunder.optBoolean("active");
        renderIconToggle(thunderButton, active,
            "Thunder sounds are on. Tap to turn them off",
            "Thunder sounds are off. Tap to turn them on");
    }

    private void renderGovernorControls(JSONObject governors) {
        renderGovernor(openAiGovernorButton, "OpenAI", governors == null ? null : governors.optJSONObject("openai"));
        renderGovernor(anthropicGovernorButton, "Anthropic", governors == null ? null : governors.optJSONObject("anthropic"));
    }

    // The governor button cycles the orchestrator's boost states: normal
    // pace, 3x (green), 10x (blue), then halted (red - no new fleet launches
    // for the provider until the cycle comes back around). The orchestrator
    // decides what each state means and reports the numbers, so the label
    // never carries a second copy of them.
    private void renderGovernor(ImageButton button, String name, JSONObject governor) {
        String state = governor == null ? "off" : governor.optString("state", "");
        if (!state.equals("off") && !state.equals("green") && !state.equals("blue") && !state.equals("red")) {
            // An older server reports only the boolean; blue is what boosted meant.
            state = governor != null && governor.optBoolean("boosted") ? "blue" : "off";
        }
        String times = governor == null ? "10\u00d7" : governor.optInt("boostedMultiplier", 10) + "\u00d7";
        int tint; int background; String description;
        switch (state) {
            case "green":
                tint = SUCCESS; background = TOOL_SUCCESS;
                description = name + " governor is using 3\u00d7 local allowance. Tap for " + times + " allowance";
                break;
            case "blue":
                tint = ACCENT; background = Color.rgb(31, 42, 58);
                description = name + " governor is using " + times + " local allowance. Tap for a launch halt";
                break;
            case "red":
                tint = DANGER; background = TOOL_ERROR;
                description = name + " governor is halted: no new fleet sessions. Tap for normal allowance";
                break;
            default:
                tint = MUTED; background = SURFACE_2;
                description = name + " governor is using normal local allowance. Tap for 3\u00d7 allowance";
                break;
        }
        button.setColorFilter(tint);
        button.setBackground(shape(background));
        button.setContentDescription(description);
        button.setSelected(!state.equals("off"));
        button.setEnabled(true);
    }

    /**
     * The ways to start a thread are the supervisor's to describe, not the app's to remember,
     * so the menu stays empty until the manifest arrives and asks again whenever it is missing.
     */
    private void refreshThreadStarts() {
        if (threadStarter == null || threadStarter.hasDestinations()) return;
        network.execute(() -> {
            try {
                JSONArray listed = api("GET", "/v1/thread-starts", null).getJSONArray("destinations");
                List<GooeyMenu.Choice> destinations = new ArrayList<>();
                for (int i = 0; i < listed.length(); i++) {
                    JSONObject entry = listed.getJSONObject(i);
                    JSONArray models = entry.optJSONArray("models");
                    List<GooeyMenu.Choice> children = new ArrayList<>();
                    for (int m = 0; models != null && m < models.length(); m++) {
                        JSONObject model = models.getJSONObject(m);
                        children.add(new GooeyMenu.Choice(model.optString("id"), model.optString("label"),
                            parseColor(model.optString("accent"), ACCENT), providerIcon(model.optString("icon")), null));
                    }
                    destinations.add(new GooeyMenu.Choice(entry.optString("id"), entry.optString("label"),
                        parseColor(entry.optString("accent"), ACCENT), providerIcon(entry.optString("icon")), children));
                }
                main.post(() -> threadStarter.setDestinations(destinations));
            } catch (Exception ignored) {
            }
        });
    }

    private int parseColor(String value, int fallback) {
        try { return Color.parseColor(value); }
        catch (Exception ignored) { return fallback; }
    }

    private void refreshMachineControls() {
        network.execute(() -> {
            try {
                JSONObject thunder = api("GET", "/v1/audio/thunder", null).optJSONObject("thunder");
                JSONObject governors = api("GET", "/v1/governor-controls", null).optJSONObject("governors");
                main.post(() -> { renderThunderStatus(thunder); renderGovernorControls(governors); });
            } catch (Exception error) {
                main.post(() -> {
                    for (ImageButton control : new ImageButton[] { thunderButton, openAiGovernorButton, anthropicGovernorButton }) {
                        control.setColorFilter(MUTED); control.setEnabled(true);
                    }
                });
            }
        });
    }

    private void toggleThunder() {
        thunderButton.setEnabled(false);
        network.execute(() -> {
            try {
                JSONObject thunder = api("POST", "/v1/audio/thunder/toggle", new JSONObject()).optJSONObject("thunder");
                main.post(() -> {
                    renderThunderStatus(thunder);
                    feelToggle(thunder != null && thunder.optBoolean("active"));
                });
            } catch (Exception error) {
                main.post(() -> { thunderButton.setEnabled(true); haptics.play(Haptics.Feel.ERROR); });
                note(shortError(error));
                refreshMachineControls();
            }
        });
    }

    private void toggleGovernor(String provider, ImageButton button) {
        button.setEnabled(false);
        network.execute(() -> {
            try {
                JSONObject governors = api("POST", "/v1/governor-controls/" + provider + "/toggle", new JSONObject())
                    .optJSONObject("governors");
                main.post(() -> {
                    renderGovernorControls(governors);
                    JSONObject governor = governors == null ? null : governors.optJSONObject(provider);
                    // The halt step lands with the "off" feel: something stopped.
                    feelToggle(governor != null && governor.optDouble("multiplier", 1) > 1);
                });
            } catch (Exception error) {
                main.post(() -> { button.setEnabled(true); haptics.play(Haptics.Feel.ERROR); });
                note(shortError(error));
                refreshMachineControls();
            }
        });
    }

    private void feelToggle(boolean on) {
        haptics.play(on ? Haptics.Feel.TOGGLE_ON : Haptics.Feel.TOGGLE_OFF);
    }

    private void openDrawer() {
        hideKeyboard(); drawerOpen = true;
        haptics.play(Haptics.Feel.PANEL_OPEN);
        refreshMachineControls();
        refreshThreadStarts();
        drawerScrim.setVisibility(View.VISIBLE);
        drawer.setVisibility(View.VISIBLE);
        if (drawer.getTranslationX() == 0f) drawer.setTranslationX(-drawer.getLayoutParams().width);
        Springs.to(drawer, DynamicAnimation.TRANSLATION_X, 0f, Springs.SLIDE_STIFFNESS, Springs.SLIDE_DAMPING);
        Springs.to(drawerScrim, DynamicAnimation.ALPHA, 1f, Springs.SLIDE_STIFFNESS, 1f);
        dealIn(drawerList);
        hamburger.setVisibility(View.GONE);
    }

    private void closeDrawer() {
        if (!drawerOpen) return;
        drawerOpen = false;
        threadStarter.collapse();
        haptics.play(Haptics.Feel.PANEL_CLOSE);
        Springs.to(drawerScrim, DynamicAnimation.ALPHA, 0f, Springs.SLIDE_STIFFNESS, 1f);
        hide(drawer, -drawer.getWidth(), () -> {
            drawerScrim.setVisibility(View.GONE);
            hamburger.setVisibility(View.VISIBLE);
        });
    }

    private void openSettings() {
        if (selectedId == null) { haptics.play(Haptics.Feel.REJECT); return; }
        hideKeyboard(); settingsOpen = true;
        haptics.play(Haptics.Feel.PANEL_OPEN);
        settingsThread.setText("Thread " + selectedName);
        settingsActivity.setText(stateLabel()); settingsActivity.setTextColor(activityColor());
        settingsCwd.setText(selectedCwd);
        modelButton.setText("Loading…"); thinkingButton.setText("Loading…"); speedButton.setText("Loading…");
        modelButton.setEnabled(false); thinkingButton.setEnabled(false); speedButton.setEnabled(false);
        settingsScrim.setVisibility(View.VISIBLE);
        settingsDrawer.setVisibility(View.VISIBLE);
        if (settingsDrawer.getTranslationX() == 0f) settingsDrawer.setTranslationX(settingsDrawer.getLayoutParams().width);
        Springs.to(settingsDrawer, DynamicAnimation.TRANSLATION_X, 0f, Springs.SLIDE_STIFFNESS, Springs.SLIDE_DAMPING);
        Springs.to(settingsScrim, DynamicAnimation.ALPHA, 1f, Springs.SLIDE_STIFFNESS, 1f);
        settingsButton.setVisibility(View.INVISIBLE);
        refreshSettings();
    }

    private void closeSettings() {
        if (!settingsOpen) return;
        settingsOpen = false;
        haptics.play(Haptics.Feel.PANEL_CLOSE);
        Springs.to(settingsScrim, DynamicAnimation.ALPHA, 0f, Springs.SLIDE_STIFFNESS, 1f);
        hide(settingsDrawer, settingsDrawer.getWidth(), () -> {
            settingsScrim.setVisibility(View.GONE);
            settingsButton.setVisibility(View.VISIBLE);
        });
    }

    /**
     * Slides a panel off and takes it out of the layout once it has actually left, rather than
     * after a duration, so reopening mid-flight simply reverses the panel that is still there.
     */
    private void hide(View panel, float offscreen, Runnable done) {
        SpringAnimation spring = Springs.of(panel, DynamicAnimation.TRANSLATION_X,
            Springs.SLIDE_STIFFNESS, Springs.SLIDE_DAMPING);
        spring.addEndListener(new DynamicAnimation.OnAnimationEndListener() {
            @Override public void onAnimationEnd(DynamicAnimation animation, boolean cancelled, float value, float velocity) {
                spring.removeEndListener(this);
                if (cancelled || value == 0f) return;
                panel.setVisibility(View.GONE);
                done.run();
            }
        });
        spring.animateToFinalPosition(offscreen);
    }

    private void refreshSettings() {
        String id = selectedId; if (id == null) return;
        network.execute(() -> {
            try {
                JSONObject result = api("GET", "/v1/sessions/" + id + "/settings", null).getJSONObject("settings");
                main.post(() -> { if (settingsOpen && Objects.equals(selectedId, id)) renderSettings(result); });
            } catch (Exception e) {
                main.post(() -> {
                    if (!settingsOpen) return;
                    modelButton.setText("Could not load settings"); thinkingButton.setText("Retry"); speedButton.setText("Retry");
                    thinkingButton.setEnabled(true); speedButton.setEnabled(true);
                    thinkingButton.setOnClickListener(v -> refreshSettings()); speedButton.setOnClickListener(v -> refreshSettings());
                    note(shortError(e));
                });
            }
        });
    }

    private void renderSettings(JSONObject settings) {
        currentModel = settings.optJSONObject("model");
        availableModels = settings.optJSONArray("models") == null ? new JSONArray() : settings.optJSONArray("models");
        availableThinkingLevels = settings.optJSONArray("thinkingLevels") == null ? new JSONArray() : settings.optJSONArray("thinkingLevels");
        currentThinkingLevel = settings.optString("thinkingLevel", "off");
        currentSpeedMode = settings.optString("speedMode", "normal");
        availableSpeedModes = settings.optJSONArray("speedModes") == null ? new JSONArray() : settings.optJSONArray("speedModes");
        String modelName = currentModel == null ? "No model" : currentModel.optString("name", currentModel.optString("id", "Unknown model"));
        modelButton.setText(modelName); modelButton.setEnabled(availableModels.length() > 0);
        thinkingButton.setText(currentThinkingLevel.toUpperCase(Locale.ROOT));
        thinkingButton.setEnabled(availableThinkingLevels.length() > 0);
        thinkingButton.setOnClickListener(v -> showThinkingPicker());
        speedButton.setText(availableSpeedModes.length() == 0 ? "Unavailable for this model" : currentSpeedMode.toUpperCase(Locale.ROOT));
        speedButton.setEnabled(availableSpeedModes.length() > 0);
        speedButton.setOnClickListener(v -> showSpeedPicker());
    }

    private void showModelPicker() {
        if (availableModels.length() == 0) return;
        List<String> labels = new ArrayList<>();
        List<JSONObject> choices = new ArrayList<>();
        for (boolean common : new boolean[]{true, false}) {
            boolean headerAdded = false;
            for (int i = 0; i < availableModels.length(); i++) {
                JSONObject model = availableModels.optJSONObject(i); if (model == null || model.optBoolean("common") != common) continue;
                if (!headerAdded) {
                    labels.add(common ? "COMMON MODELS" : "UNCOMMON MODELS"); choices.add(null); headerAdded = true;
                }
                boolean selected = currentModel != null
                    && model.optString("provider").equals(currentModel.optString("provider"))
                    && model.optString("id").equals(currentModel.optString("id"));
                labels.add((selected ? "✓  " : "    ") + model.optString("name", model.optString("id"))
                    + "\n    " + model.optString("provider"));
                choices.add(model);
            }
        }
        ArrayAdapter<String> adapter = new ArrayAdapter<String>(this, android.R.layout.simple_list_item_1, labels) {
            @Override public boolean isEnabled(int position) { return choices.get(position) != null; }
            @Override public View getView(int position, View convertView, android.view.ViewGroup parent) {
                TextView view = (TextView) super.getView(position, convertView, parent);
                boolean header = choices.get(position) == null;
                view.setTextColor(header ? MUTED : TEXT); view.setTextSize(header ? 11 : 15);
                view.setTypeface(Typeface.DEFAULT, header ? Typeface.BOLD : Typeface.NORMAL);
                view.setPadding(dp(18), header ? dp(14) : dp(10), dp(18), header ? dp(5) : dp(10));
                return view;
            }
        };
        AlertDialog dialog = new AlertDialog.Builder(this, AlertDialog.THEME_DEVICE_DEFAULT_DARK)
            .setTitle("Model").setAdapter(adapter, (d, which) -> {
                JSONObject model = choices.get(which); if (model == null) return; d.dismiss();
                haptics.play(Haptics.Feel.PICK);
                try {
                    updateSettings(new JSONObject().put("modelProvider", model.optString("provider"))
                        .put("modelId", model.optString("id")));
                } catch (JSONException e) { note(shortError(e)); }
            }).setNegativeButton("Cancel", null).create();
        styleDialog(dialog); dialog.show();
    }

    /**
     * Asks for the key that opens this person's folder on the machine. The caller
     * is a background thread waiting on the queue, so every path out of the dialog
     * has to answer it, including dismissal.
     */
    private void askForKey(String failureMessage, java.util.concurrent.BlockingQueue<String> answer) {
        runOnUiThread(() -> {
            EditText field = new EditText(this);
            field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
            field.setTextColor(TEXT);
            field.setHint("Key");
            field.setHintTextColor(MUTED);
            FrameLayout frame = new FrameLayout(this);
            frame.setPadding(dp(22), dp(8), dp(22), 0);
            frame.addView(field);
            AlertDialog dialog = new AlertDialog.Builder(this, AlertDialog.THEME_DEVICE_DEFAULT_DARK)
                .setTitle("Unlock your folder")
                .setMessage(failureMessage == null
                    ? "Your folder and your threads are encrypted on the machine. This key stays on this phone."
                    : failureMessage)
                .setView(frame)
                .setCancelable(false)
                .setPositiveButton("Unlock", (d, which) -> answer.offer(field.getText().toString()))
                .setNegativeButton("Not now", (d, which) -> answer.offer(""))
                .create();
            dialog.setOnDismissListener(d -> answer.offer(""));
            styleDialog(dialog);
            dialog.show();
            field.requestFocus();
        });
    }

    private void showThinkingPicker() {
        if (availableThinkingLevels.length() == 0) return;
        String[] labels = new String[availableThinkingLevels.length()];
        int checked = -1;
        for (int i = 0; i < labels.length; i++) {
            labels[i] = availableThinkingLevels.optString(i).toUpperCase(Locale.ROOT);
            if (availableThinkingLevels.optString(i).equals(currentThinkingLevel)) checked = i;
        }
        AlertDialog dialog = new AlertDialog.Builder(this, AlertDialog.THEME_DEVICE_DEFAULT_DARK)
            .setTitle("Thinking level").setSingleChoiceItems(labels, checked, (d, which) -> {
                String level = availableThinkingLevels.optString(which); d.dismiss();
                haptics.play(Haptics.Feel.PICK);
                try { updateSettings(new JSONObject().put("thinkingLevel", level)); }
                catch (JSONException e) { note(shortError(e)); }
            }).setNegativeButton("Cancel", null).create();
        styleDialog(dialog); dialog.show();
    }

    private void showSpeedPicker() {
        if (availableSpeedModes.length() == 0) return;
        String[] labels = new String[availableSpeedModes.length()];
        int checked = -1;
        for (int i = 0; i < labels.length; i++) {
            String mode = availableSpeedModes.optString(i);
            labels[i] = mode.toUpperCase(Locale.ROOT);
            if (mode.equals(currentSpeedMode)) checked = i;
        }
        AlertDialog dialog = new AlertDialog.Builder(this, AlertDialog.THEME_DEVICE_DEFAULT_DARK)
            .setTitle("Speed mode").setSingleChoiceItems(labels, checked, (d, which) -> {
                String mode = availableSpeedModes.optString(which); d.dismiss();
                haptics.play(Haptics.Feel.PICK);
                try { updateSettings(new JSONObject().put("speedMode", mode)); }
                catch (JSONException e) { note(shortError(e)); }
            }).setNegativeButton("Cancel", null).create();
        styleDialog(dialog); dialog.show();
    }

    private void styleDialog(AlertDialog dialog) {
        dialog.setOnShowListener(x -> {
            dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setTextColor(ACCENT);
            if (dialog.getWindow() != null) dialog.getWindow().setBackgroundDrawable(shape(SURFACE));
        });
    }

    private void updateSettings(JSONObject body) {
        String id = selectedId; if (id == null) return;
        modelButton.setEnabled(false); thinkingButton.setEnabled(false); speedButton.setEnabled(false);
        network.execute(() -> {
            try {
                JSONObject settings = api("PUT", "/v1/sessions/" + id + "/settings", body).getJSONObject("settings");
                main.post(() -> {
                    haptics.play(Haptics.Feel.CONFIRM);
                    if (settingsOpen && Objects.equals(selectedId, id)) renderSettings(settings);
                });
            } catch (Exception e) {
                main.post(() -> haptics.play(Haptics.Feel.ERROR));
                note(shortError(e)); main.post(this::refreshSettings);
            }
        });
    }

    private void hideKeyboard() {
        View focused = getCurrentFocus();
        if (focused != null) ((InputMethodManager) getSystemService(INPUT_METHOD_SERVICE))
            .hideSoftInputFromWindow(focused.getWindowToken(), 0);
    }

    private void refresh() {
        if (activityVisible) publishOpenThread();
        if (polling) { refreshAgain = true; return; }
        polling = true;
        String requestedSession = selectedId;
        String requestedAgent = agentRunId;
        boolean requestedAgentList = DRAWER_TAB_ORCHESTRATOR.equals(drawerTab) || agentRunId != null;
        long requestedAfter = lastSeq;
        long requestedSelectionGeneration = selectionGeneration;
        long requestedActionGeneration = actionGeneration;
        pollNetwork.execute(() -> {
            try {
                JSONObject all = api("GET", "/v1/sessions", null);
                JSONObject selectedEvents = null;
                boolean selectedMissing = false;
                if (requestedSession != null && requestedAgent == null) {
                    try { selectedEvents = api("GET", "/v1/sessions/" + requestedSession + "/events?after=" + requestedAfter, null); }
                    catch (Exception failure) {
                        // The thread itself is the authority on whether it still exists. The
                        // drawer list is not: it shows only interactive threads, and treating
                        // absence from it as deletion threw the user out of any archived thread
                        // they had deliberately opened, one poll after opening it.
                        selectedMissing = isMissing(failure);
                    }
                }
                boolean selectedThreadGone = selectedMissing;
                JSONObject agentRunList = null;
                String agentListError = "";
                if (requestedAgentList) {
                    try { agentRunList = api("GET", "/v1/agents/runs", null); }
                    catch (Exception failure) { agentListError = "Agents unavailable · " + shortError(failure); }
                }
                JSONObject agentRunEvents = null;
                if (requestedAgent != null) {
                    // A run is addressed by host and run id together, so the
                    // separator between them is escaped rather than routed on.
                    String addressed = requestedAgent.replace(":", "%3A");
                    try { agentRunEvents = api("GET", "/v1/agents/runs/" + addressed + "/events?after=" + requestedAfter, null); }
                    catch (Exception ignored) { /* A transient read leaves the observed transcript unchanged. */ }
                }
                JSONObject events = selectedEvents;
                JSONObject observedList = agentRunList;
                JSONObject observedEvents = agentRunEvents;
                String observedListError = agentListError;
                main.post(() -> {
                    if (requestedAgentList) {
                        if (observedList != null) {
                            JSONArray runs = observedList.optJSONArray("runs");
                            JSONArray hosts = observedList.optJSONArray("hosts");
                            agentRuns = runs == null ? new JSONArray() : runs;
                            agentHosts = hosts == null ? new JSONArray() : hosts;
                            agentRunningCount = observedList.optInt("running");
                            agentHostFailing = false;
                            for (int index = 0; index < agentHosts.length(); index++) {
                                JSONObject host = agentHosts.optJSONObject(index);
                                if (!optionalJsonString(host, "error").isEmpty()) agentHostFailing = true;
                            }
                            agentError = "";
                        } else {
                            agentError = observedListError;
                        }
                        renderAgentSection();
                    }
                    if (observedEvents != null && Objects.equals(agentRunId, requestedAgent)
                        && requestedSelectionGeneration == selectionGeneration) {
                        applyObservedRun(observedEvents.optJSONObject("run"));
                        renderEvents(observedEvents);
                        updateComposer(); updateTopBar();
                    }
                    archiveSupported = all.has("archivedSessions") && all.optJSONArray("archivedSessions") != null;
                    JSONArray archivedPage = all.optJSONArray("archivedSessions");
                    archivedTotal = all.optInt("archivedTotal", archivedPage == null ? 0 : archivedPage.length());
                    lastSessions = all.optJSONArray("sessions") == null ? new JSONArray() : all.optJSONArray("sessions");
                    lastArchivedPage = archivedPage == null ? new JSONArray() : archivedPage;
                    renderSessions(lastSessions, lastArchivedPage,
                        requestedSelectionGeneration, requestedActionGeneration);
                    renderAgents(all.optJSONObject("agents"));
                    renderPlanUsage(all.optJSONObject("plans"));
                    renderGovernorControls(all.optJSONObject("governors"));
                    renderMachineUsage(all.optJSONObject("machine"));
                    // Asked after the drawer render, not before it: a notification opens its
                    // thread from inside that render, and this answer belongs to whichever
                    // thread was open when the poll left.
                    if (selectedThreadGone && SelectionGate.transcriptApplies(requestedSelectionGeneration,
                            selectionGeneration, requestedSession, selectedId, agentRunId != null)) {
                        clearSelection();
                    }
                    if (events != null && SelectionGate.transcriptApplies(requestedSelectionGeneration,
                            selectionGeneration, requestedSession, selectedId, agentRunId != null)) {
                        if (SelectionGate.snapshotApplies(requestedActionGeneration, actionGeneration,
                            selectedActionInFlight())) applySelectedSnapshot(events.optJSONObject("session"), false);
                        renderEvents(events);
                    }
                    updateComposer(); updateTopBar();
                    connection.setVisibility(View.GONE);
                    finishRefresh();
                });
            } catch (Exception e) {
                main.post(() -> {
                    connection.setText("●  Offline · " + shortError(e)); connection.setTextColor(DANGER);
                    connection.setVisibility(View.VISIBLE);
                    topState.setText("OFFLINE"); topState.setTextColor(DANGER);
                    finishRefresh();
                });
            }
        });
    }

    private void finishRefresh() {
        polling = false;
        if (refreshAgain) { refreshAgain = false; main.post(this::refresh); }
    }

    private String optionalJsonString(JSONObject object, String key) {
        return object == null || object.isNull(key) ? "" : object.optString(key, "");
    }

    private JSONObject agentLocation(JSONObject agents, String key) {
        if (agents == null) return null;
        JSONArray locations = agents.optJSONArray("locations");
        if (locations == null) return null;
        for (int i = 0; i < locations.length(); i++) {
            JSONObject location = locations.optJSONObject(i);
            if (location != null && key.equals(location.optString("key"))) return location;
        }
        return null;
    }

    private void renderAgentLocation(TextView output, JSONObject location, String label) {
        if (location == null) {
            output.setText("—");
            output.setContentDescription(label + " agent counts unavailable");
            return;
        }
        List<String> counts = new ArrayList<>();
        JSONArray models = location.optJSONArray("models");
        if (models != null) for (int i = 0; i < models.length(); i++) {
            JSONObject model = models.optJSONObject(i); if (model == null) continue;
            counts.add(model.optString("label", "OTHER") + " " + model.optInt("count"));
        }
        output.setText(counts.isEmpty() ? "NO AGENTS" : String.join(" · ", counts));
        String error = optionalJsonString(location, "error");
        output.setContentDescription(!error.isEmpty() ? error
            : counts.isEmpty() ? label + ": no agents running"
            : label + ": " + String.join(", ", counts) + " agents running");
    }

    private void renderAgents(JSONObject agents) {
        renderAgentLocation(workAgentSummary, agentLocation(agents, "work"), "WORK");
        renderAgentLocation(localAgentSummary, agentLocation(agents, "local"), "THIS MACHINE");
        if (agents != null) {
            JSONObject sources = agents.optJSONObject("sources");
            if (sources != null && sources.has("orchestrator"))
                agentRunningCount = sources.optInt("orchestrator");
            JSONArray locations = agents.optJSONArray("locations");
            agentHostFailing = false;
            if (locations != null) for (int index = 0; index < locations.length(); index++) {
                JSONObject location = locations.optJSONObject(index);
                if (!optionalJsonString(location, "error").isEmpty()) agentHostFailing = true;
            }
        }
        renderDrawerTabs();
    }

    private String agentRunLabel(JSONObject run) {
        return AgentRunView.statusLabel(run.optString("status", "running"), run.optString("activity", "WORKING"));
    }

    private String observedStatusLabel() {
        return AgentRunView.statusLabel(agentRunStatus, agentRunActivity);
    }

    private void renderAgentSection() {
        if (!DRAWER_TAB_ORCHESTRATOR.equals(drawerTab)) return;
        agentList.removeAllViews();
        if (!agentError.isEmpty()) {
            agentList.addView(agentNote(agentError, MUTED), new LinearLayout.LayoutParams(-1, -2));
            return;
        }
        // Agents run on more than one machine, so each host states its own count
        // and its own reachability rather than being merged into one number.
        for (int hostIndex = 0; hostIndex < Math.max(1, agentHosts.length()); hostIndex++) {
            JSONObject host = agentHosts.optJSONObject(hostIndex);
            String key = host == null ? "local" : host.optString("key", "local");
            String name = host == null ? "This machine" : host.optString("name", key);
            String failure = optionalJsonString(host, "error");
            TextView heading = text(name.toUpperCase(Locale.ROOT) + " · "
                + (failure.isEmpty() ? String.valueOf(host == null ? agentRunningCount : host.optInt("running")) : "UNREACHABLE"), 11, true);
            heading.setTextColor(failure.isEmpty() ? MUTED : DANGER);
            heading.setPadding(dp(14), dp(9), dp(14), dp(4));
            agentList.addView(heading, new LinearLayout.LayoutParams(-1, -2));
            if (!failure.isEmpty()) {
                agentList.addView(agentNote(failure, DANGER), new LinearLayout.LayoutParams(-1, -2));
                continue;
            }
            int shown = 0;
            for (int index = 0; index < agentRuns.length(); index++) {
                JSONObject run = agentRuns.optJSONObject(index);
                if (run == null || !key.equals(run.optString("host", "local"))) continue;
                agentList.addView(agentRunRow(run), new LinearLayout.LayoutParams(-1, dp(60)));
                shown++;
            }
            if (shown == 0) agentList.addView(agentNote("No agents working", MUTED), new LinearLayout.LayoutParams(-1, -2));
        }
    }

    private TextView agentNote(String message, int color) {
        TextView note = text(message, 12, true);
        note.setTextColor(color);
        note.setPadding(dp(14), dp(10), dp(14), dp(10));
        return note;
    }

    private View agentRunRow(JSONObject run) {
        String id = run.optString("id");
        boolean selected = id.equals(agentRunId);
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.VERTICAL);
        row.setPadding(dp(14), dp(7), dp(14), dp(7));
        row.setBackground(shape(selected ? SURFACE_2 : SURFACE));
        LinearLayout title = new LinearLayout(this); title.setGravity(Gravity.CENTER_VERTICAL);
        TextView label = text(run.optString("label", "AGENT"), 12, true); label.setTextColor(ACCENT);
        TextView task = text(run.optString("taskId", ""), 14, true);
        task.setSingleLine(true); task.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams taskParams = new LinearLayout.LayoutParams(0, -2, 1);
        taskParams.setMarginStart(dp(7));
        title.addView(label, new LinearLayout.LayoutParams(-2, -2));
        title.addView(task, taskParams);
        String status = agentRunLabel(run);
        TextView meta = text(status + " · " + AgentRunView.duration(run.optLong("elapsedMs"))
            + (run.optBoolean("observable") ? "" : " · no transcript"), 11, true);
        meta.setTextColor("running".equals(run.optString("status")) ? activityColor(run.optString("activity", "WORKING")) : MUTED);
        meta.setSingleLine(true); meta.setEllipsize(TextUtils.TruncateAt.END);
        row.addView(title, new LinearLayout.LayoutParams(-1, -2));
        row.addView(meta, new LinearLayout.LayoutParams(-1, -2));
        row.setContentDescription("Observe " + run.optString("label") + " agent on task "
            + run.optString("taskId") + " on " + run.optString("hostName", "this machine") + ", " + status);
        row.setOnClickListener(v -> { openAgentRun(run); closeDrawer(); });
        return row;
    }

    private void applyObservedRun(JSONObject run) {
        if (run == null) return;
        agentRunLabel = run.optString("label", "Agent");
        agentRunTask = run.optString("taskId", "");
        agentRunStatus = run.optString("status", "running");
        agentRunActivity = run.optString("activity", "WORKING");
        agentRunProvider = run.optString("provider", "");
        agentRunElapsedMs = run.optLong("elapsedMs");
    }

    private void openAgentRun(JSONObject run) {
        String id = run.optString("id");
        if (id.isEmpty() || id.equals(agentRunId)) return;
        haptics.play(Haptics.Feel.AGENT_OPEN);
        selectionGeneration++;
        agentRunId = id;
        applyObservedRun(run);
        resetTranscript();
        detail.setVisibility(View.VISIBLE); emptyBox.setVisibility(View.GONE);
        hideKeyboard();
        updateComposer(); updateTopBar(); renderAgentSection();
        refresh();
    }

    private void resetTranscript() {
        transcriptOpenedMs = SystemClock.uptimeMillis();
        lastSeq = 0; transcriptScroll.resetToEnd();
        transcript.removeAllViews(); toolCards.clear(); userMessageLabels.clear();
        liveAnswer = null; liveThought = null;
    }

    private void updateUsageSummary() {
        usageSummary.setText(machineUsageText);
        usageSummary.setTextColor(machineUsageColor);
        usageSummary.setContentDescription(machineUsageDescription);
    }

    private int providerIcon(String icon) {
        String resource = "ic_" + icon.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9_]", "_");
        int id = getResources().getIdentifier(resource, "drawable", getPackageName());
        return id == 0 ? R.drawable.ic_provider : id;
    }

    private void renderPlanUsage(JSONObject plans) {
        planSummary.removeAllViews();
        JSONArray cards = plans == null ? null : plans.optJSONArray("cards");
        List<String> descriptions = new ArrayList<>();
        if (cards != null) for (int index = 0; index < cards.length(); index++) {
            JSONObject card = cards.optJSONObject(index);
            if (card == null) continue;
            String label = card.optString("label", "Provider");
            LinearLayout row = new LinearLayout(this); row.setGravity(Gravity.CENTER_VERTICAL);
            ImageView icon = new ImageView(this); icon.setImageResource(providerIcon(card.optString("icon", "provider")));
            icon.setContentDescription(label);
            row.addView(icon, new LinearLayout.LayoutParams(dp(14), dp(14)));
            TextView value = text(card.optString("text", "—"), 11, true); value.setTextColor(MUTED);
            value.setSingleLine(true); value.setEllipsize(TextUtils.TruncateAt.END);
            LinearLayout.LayoutParams valueParams = new LinearLayout.LayoutParams(0, dp(28), 1);
            valueParams.leftMargin = dp(5); row.addView(value, valueParams);
            String description = card.optString("description", label + " plan usage unavailable");
            row.setContentDescription(description); descriptions.add(description);
            planSummary.addView(row, new LinearLayout.LayoutParams(-1, dp(28)));
        }
        if (planSummary.getChildCount() == 0) {
            TextView unavailable = text("—", 11, true); unavailable.setTextColor(MUTED);
            planSummary.addView(unavailable, new LinearLayout.LayoutParams(-1, dp(28)));
            descriptions.add("Plan capacity unavailable");
        }
        planSummary.setContentDescription(String.join(". ", descriptions));
    }

    private String gib(long bytes) {
        return String.format(Locale.ROOT, "%.1f GB", bytes / 1_073_741_824.0);
    }

    private void renderMachineUsage(JSONObject machine) {
        if (machine == null) {
            machineUsageText = "CPU — · GPU — · RAM — · DISK —"; machineUsageDescription = machineUsageText; machineUsageColor = MUTED;
            updateUsageSummary(); return;
        }
        JSONObject memory = machine.optJSONObject("memory");
        JSONObject disk = machine.optJSONObject("disk");
        String cpu = machine.has("cpuPercent") && !machine.isNull("cpuPercent")
            ? machine.optInt("cpuPercent") + "%" : "—";
        String gpu = machine.has("gpuPercent") && !machine.isNull("gpuPercent")
            ? machine.optInt("gpuPercent") + "%" : "—";
        String ram = memory == null ? "—" : memory.optInt("percentUsed") + "%";
        String storage = disk == null ? "—" : disk.optInt("percentUsed") + "%";
        machineUsageText = "CPU " + cpu + " · GPU " + gpu + " · RAM " + ram + " · DISK " + storage;
        machineUsageDescription = machineUsageText;
        if (memory != null) machineUsageDescription += ". RAM " + gib(memory.optLong("usedBytes")) + " of " + gib(memory.optLong("totalBytes"));
        if (disk != null) machineUsageDescription += ". Disk " + gib(disk.optLong("usedBytes")) + " of " + gib(disk.optLong("totalBytes"));
        int ramPercent = memory == null ? 0 : memory.optInt("percentUsed");
        int diskPercent = disk == null ? 0 : disk.optInt("percentUsed");
        machineUsageColor = ramPercent >= 90 || diskPercent >= 90 ? DANGER : MUTED;
        updateUsageSummary();
    }

    private void renderSessions(JSONArray rows, JSONArray archivedRows,
                                long requestedSelectionGeneration, long requestedActionGeneration) {
        drawerList.removeAllViews();
        archivedList.removeAllViews();
        if (rows == null) return;
        if (archivedRows == null) archivedRows = new JSONArray();
        JSONObject first = rows.optJSONObject(0);
        Set<String> currentlyActive = new HashSet<>();
        ArrayList<String> watchIds = new ArrayList<>(), watchNames = new ArrayList<>();
        for (int i = 0; i < rows.length(); i++) {
            JSONObject s = rows.optJSONObject(i); if (s == null) continue;
            String id = s.optString("id"), name = s.optString("name", "Agent");
            String state = s.optString("state"), cwd = s.optString("cwd", "/");
            String activity = s.optString("activity", activityFromState(state));
            String activeTool = s.optString("activeTool", "");
            String provider = "work".equals(s.optString("environment")) ? "work"
                : "converge".equals(s.optString("environment")) ? "converge"
                : "personal".equals(s.optString("environment")) ? "personal"
                : "anthropic".equals(s.optString("provider")) ? "anthropic" : "openai";
            boolean locallyAborting = id.equals(selectedId) && "abort".equals(actionTypes.get(id));
            if (("RUNNING".equals(state) || "STARTING".equals(state)) && !locallyAborting) {
                currentlyActive.add(id);
                if (requestedCompletionWatches.add(id)) { watchIds.add(id); watchNames.add(name); }
            }
            boolean selected = id.equals(selectedId);
            if (selected) {
                if (requestedSelectionGeneration == selectionGeneration
                    && requestedActionGeneration == actionGeneration && !selectedActionInFlight()) {
                    applySelectedSnapshot(s, false);
                }
            }
            drawerList.addView(agentRow(id, name, cwd, state, activity, activeTool, provider, selected, s.optLong("revision"),
                    s.optInt("steeringQueued"), s.optInt("followUpQueued"), s.optJSONArray("queuedMessages")),
                new LinearLayout.LayoutParams(-1, dp(76)));
        }
        if (rows.length() == 0)
            drawerList.addView(agentNote("No threads", MUTED), new LinearLayout.LayoutParams(-1, -2));
        if (DRAWER_TAB_ARCHIVED.equals(drawerTab)) {
            if (!archiveSupported) {
                archivedList.addView(agentNote("Archived threads unavailable", MUTED), new LinearLayout.LayoutParams(-1, -2));
            } else {
                ArrayList<JSONObject> archivedLoaded = loadedArchived(archivedRows);
                int total = Math.max(archivedTotal, archivedLoaded.size());
                if (archivedLoaded.isEmpty())
                    archivedList.addView(agentNote("No archived threads", MUTED), new LinearLayout.LayoutParams(-1, -2));
                for (JSONObject archived : archivedLoaded)
                    archivedList.addView(archivedAgentRow(archived), new LinearLayout.LayoutParams(-1, dp(68)));
                if (archivedLoaded.size() < total) {
                    int remaining = total - archivedLoaded.size();
                    Button older = button(archivedOlderLoading
                        ? "Loading older threads…" : "Show older · " + remaining + " more", false);
                    older.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
                    older.setTextColor(archivedOlderLoading ? MUTED : ACCENT);
                    older.setTextSize(12);
                    older.setContentDescription("Load " + Math.min(remaining, ARCHIVED_PAGE_SIZE) + " older archived threads");
                    older.setEnabled(!archivedOlderLoading);
                    older.setOnClickListener(v -> { loadOlderArchived(archivedLoaded.size()); redrawSessions(); });
                    archivedList.addView(older, new LinearLayout.LayoutParams(-1, dp(44)));
                }
            }
        }
        renderDrawerTabs();

        requestedCompletionWatches.retainAll(currentlyActive);
        if (!CompletionNotificationService.watchSessions(this, watchIds, watchNames))
            requestedCompletionWatches.removeAll(watchIds);
        // Nothing claims the screen while a named thread is on its way to it.
        if (selectedId == null && first != null && requestedSelectionGeneration == selectionGeneration
            && agentRunId == null && openingThreadId == null) {
            select(first.optString("id"), first.optString("name", "Agent"),
                first.optString("cwd", "/"), first.optString("state", "STOPPED"),
                first.optString("activity", activityFromState(first.optString("state", "STOPPED"))),
                first.optString("activeTool", ""), first.optLong("revision"),
                first.optInt("steeringQueued"), first.optInt("followUpQueued"), first.optJSONArray("queuedMessages"));
        }
        if (agentRunId == null) {
            emptyBox.setVisibility(rows.length() == 0 ? View.VISIBLE : View.GONE);
            if (rows.length() == 0) detail.setVisibility(View.GONE);
        }
    }

    private View agentRow(String id, String name, String cwd, String state, String activity, String activeTool, String provider,
                          boolean selected, long revision, int steeringQueued, int followUpQueued, JSONArray queuedMessages) {
        FrameLayout swipe = new FrameLayout(this);
        swipe.setBackgroundColor(TOOL_SUCCESS);
        TextView archiveHint = text("ARCHIVE", 11, true);
        archiveHint.setTextColor(SUCCESS); archiveHint.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
        archiveHint.setPadding(0, 0, dp(22), 0); archiveHint.setVisibility(archiveSupported ? View.VISIBLE : View.GONE);
        swipe.addView(archiveHint, new FrameLayout.LayoutParams(-1, -1));

        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL); row.setPadding(dp(14), dp(7), dp(14), dp(7));
        row.setBackground(selected ? shape(SURFACE_2) : shape(SURFACE));
        String providerName = "work".equals(provider) ? "Work" : "converge".equals(provider) ? "Cloud"
            : "personal".equals(provider) ? "Personal"
            : "anthropic".equals(provider) ? "Anthropic" : "OpenAI";
        row.setContentDescription("Open " + providerName + " thread " + name + ", " + activityLabel(activity, activeTool)
            + (archiveSupported ? ". Swipe left to archive" : ""));
        TextView nameView = text(name, 16, true);
        LinearLayout identity = new LinearLayout(this); identity.setOrientation(LinearLayout.VERTICAL);
        identity.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout meta = new LinearLayout(this); meta.setGravity(Gravity.CENTER_VERTICAL);
        ImageView providerIcon = new ImageView(this);
        providerIcon.setImageResource("work".equals(provider) ? R.drawable.ic_work
            : "converge".equals(provider) ? R.drawable.ic_converge
            : "personal".equals(provider) ? R.drawable.ic_personal
            : "anthropic".equals(provider) ? R.drawable.ic_anthropic : R.drawable.ic_openai);
        providerIcon.setAlpha(0.82f); providerIcon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        TextView stateView = text(activityLabel(activity, activeTool), 12, true);
        stateView.setTextColor(activityColor(activity));
        LinearLayout.LayoutParams iconParams = new LinearLayout.LayoutParams(dp(14), dp(14));
        iconParams.setMarginEnd(dp(6));
        meta.addView(providerIcon, iconParams);
        meta.addView(stateView, new LinearLayout.LayoutParams(0, dp(24), 1));
        identity.addView(nameView, new LinearLayout.LayoutParams(-1, dp(30)));
        identity.addView(meta, new LinearLayout.LayoutParams(-1, dp(24)));
        row.addView(identity, new LinearLayout.LayoutParams(0, -1, 1));
        row.setOnClickListener(v -> {
            // Opening a thread is felt where it is asked for, not inside select, which the app
            // also calls on its own to put something on screen at launch.
            haptics.play(Haptics.Feel.THREAD_OPEN);
            select(id, name, cwd, state, activity, activeTool, revision, steeringQueued, followUpQueued, queuedMessages); closeDrawer();
        });
        installArchiveSlide(swipe, row, id, name);
        swipe.addView(row, new FrameLayout.LayoutParams(-1, -1));
        return swipe;
    }

    /**
     * Swipe to archive, with the drag itself rendered as resistance: ticks that grow heavier
     * and closer together the nearer the row comes to the commit threshold, a distinct catch
     * when it crosses, and its release when it falls back.
     */
    private void installArchiveSlide(FrameLayout container, View foreground, String id, String name) {
        float[] start = new float[2];
        boolean[] sliding = { false };
        boolean[] armed = { false };
        int slop = ViewConfiguration.get(this).getScaledTouchSlop();
        VelocityTracker[] tracker = new VelocityTracker[1];
        foreground.setOnTouchListener((view, event) -> {
            float threshold = Math.min(dp(110), Math.max(1f, container.getWidth() * 0.35f));
            VelocityTracker velocity = tracker[0];
            if (velocity != null) velocity.addMovement(event);
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    if (velocity != null) velocity.recycle();
                    velocity = VelocityTracker.obtain(); velocity.addMovement(event); tracker[0] = velocity;
                    Springs.of(foreground, DynamicAnimation.TRANSLATION_X,
                        Springs.POP_STIFFNESS, Springs.POP_DAMPING).cancel();
                    foreground.setTranslationX(0);
                    start[0] = event.getRawX(); start[1] = event.getRawY();
                    sliding[0] = false; armed[0] = false;
                    haptics.play(Haptics.Feel.PRESS, foreground);
                    return true;
                case MotionEvent.ACTION_MOVE:
                    float dx = event.getRawX() - start[0], dy = event.getRawY() - start[1];
                    if (!sliding[0] && Math.abs(dx) < slop && Math.abs(dy) < slop) return true;
                    if (!sliding[0] && (dx >= 0 || Math.abs(dy) >= Math.abs(dx))) return false;
                    if (!archiveSupported) return true;
                    if (!sliding[0]) haptics.dragStarted();
                    sliding[0] = true;
                    foreground.getParent().requestDisallowInterceptTouchEvent(true);
                    foreground.setTranslationX(Math.max(-container.getWidth(), Math.min(0, dx)));
                    float progress = -foreground.getTranslationX() / threshold;
                    haptics.dragProgress(progress);
                    boolean crossed = progress >= 1f;
                    if (crossed != armed[0]) {
                        armed[0] = crossed;
                        haptics.play(crossed ? Haptics.Feel.THRESHOLD_ARM : Haptics.Feel.THRESHOLD_DISARM, foreground);
                    }
                    return true;
                case MotionEvent.ACTION_UP:
                    haptics.dragEnded();
                    if (!sliding[0]) {
                        if (velocity != null) { velocity.recycle(); tracker[0] = null; }
                        view.performClick(); return true;
                    }
                    foreground.getParent().requestDisallowInterceptTouchEvent(false);
                    // The row leaves or returns carrying the speed the finger left it with.
                    float thrown = 0f;
                    if (velocity != null) {
                        velocity.computeCurrentVelocity(1000);
                        thrown = velocity.getXVelocity();
                        velocity.recycle(); tracker[0] = null;
                    }
                    if (-foreground.getTranslationX() >= threshold) {
                        haptics.play(Haptics.Feel.ARCHIVE, foreground);
                        Springs.release(foreground, DynamicAnimation.TRANSLATION_X, -container.getWidth(),
                            thrown, Springs.SLIDE_STIFFNESS, 1f);
                        foreground.postDelayed(() -> archiveAgent(id, name, foreground), 140);
                    } else {
                        haptics.play(Haptics.Feel.DISMISS, foreground);
                        Springs.release(foreground, DynamicAnimation.TRANSLATION_X, 0f, thrown,
                            Springs.POP_STIFFNESS, Springs.POP_DAMPING);
                    }
                    return true;
                case MotionEvent.ACTION_CANCEL:
                    haptics.dragEnded();
                    if (velocity != null) { velocity.recycle(); tracker[0] = null; }
                    foreground.getParent().requestDisallowInterceptTouchEvent(false);
                    Springs.to(foreground, DynamicAnimation.TRANSLATION_X, 0f,
                        Springs.POP_STIFFNESS, Springs.POP_DAMPING);
                    return true;
                default: return false;
            }
        });
    }

    /**
     * Runs a list in from the side one row at a time. The stagger is what makes a list read as
     * a set of separate things rather than a rectangle of text that blinked into place.
     */
    private void dealIn(LinearLayout list) {
        list.post(() -> {
            for (int i = 0; i < list.getChildCount(); i++) {
                View row = list.getChildAt(i);
                row.setAlpha(0f);
                row.setTranslationX(-dp(28));
                final int index = i;
                row.postDelayed(() -> {
                    Springs.to(row, DynamicAnimation.ALPHA, 1f, Springs.POP_STIFFNESS, 1f);
                    Springs.to(row, DynamicAnimation.TRANSLATION_X, 0f, Springs.POP_STIFFNESS, Springs.POP_DAMPING);
                }, index * 22L);
            }
        });
    }

    /** Redraws the drawer from the newest polled snapshot, without waiting for another poll. */
    private void redrawSessions() {
        renderSessions(lastSessions, lastArchivedPage, selectionGeneration, actionGeneration);
    }

    /** The polled newest page followed by any explicitly loaded older pages, without duplicates. */
    private ArrayList<JSONObject> loadedArchived(JSONArray archivedRows) {
        ArrayList<JSONObject> loaded = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < archivedRows.length(); i++) {
            JSONObject session = archivedRows.optJSONObject(i);
            if (session != null && seen.add(session.optString("id"))) loaded.add(session);
        }
        JSONArray retained = new JSONArray();
        for (int i = 0; i < archivedOlder.length(); i++) {
            JSONObject session = archivedOlder.optJSONObject(i);
            if (session == null || !seen.add(session.optString("id"))) continue;
            loaded.add(session);
            retained.put(session);
        }
        archivedOlder = retained;
        return loaded;
    }

    private void dropArchivedOlder(String id) {
        JSONArray retained = new JSONArray();
        for (int i = 0; i < archivedOlder.length(); i++) {
            JSONObject session = archivedOlder.optJSONObject(i);
            if (session != null && !session.optString("id").equals(id)) retained.put(session);
        }
        archivedOlder = retained;
    }

    private void loadOlderArchived(int offset) {
        if (archivedOlderLoading) return;
        archivedOlderLoading = true;
        network.execute(() -> {
            try {
                JSONObject page = api("GET", "/v1/sessions/archived?offset=" + offset + "&limit=" + ARCHIVED_PAGE_SIZE, null);
                JSONArray sessions = page.optJSONArray("sessions");
                int total = page.optInt("total", archivedTotal);
                main.post(() -> {
                    archivedTotal = total;
                    if (sessions != null) for (int i = 0; i < sessions.length(); i++) {
                        JSONObject session = sessions.optJSONObject(i);
                        if (session != null) archivedOlder.put(session);
                    }
                    archivedOlderLoading = false;
                    redrawSessions();
                });
            } catch (Exception e) {
                main.post(() -> { archivedOlderLoading = false; redrawSessions(); });
                note(shortError(e));
            }
        });
    }

    private View archivedAgentRow(JSONObject session) {
        String id = session.optString("id"), name = session.optString("name", "Agent");
        String provider = "work".equals(session.optString("environment")) ? "work"
            : "converge".equals(session.optString("environment")) ? "converge"
            : "personal".equals(session.optString("environment")) ? "personal"
            : "anthropic".equals(session.optString("provider")) ? "anthropic" : "openai";
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL); row.setPadding(dp(14), dp(5), dp(8), dp(5)); row.setAlpha(0.78f);
        ImageView icon = new ImageView(this);
        icon.setImageResource("work".equals(provider) ? R.drawable.ic_work
            : "converge".equals(provider) ? R.drawable.ic_converge
            : "personal".equals(provider) ? R.drawable.ic_personal
            : "anthropic".equals(provider) ? R.drawable.ic_anthropic : R.drawable.ic_openai);
        icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        row.addView(icon, new LinearLayout.LayoutParams(dp(16), dp(16)));
        LinearLayout copy = new LinearLayout(this); copy.setOrientation(LinearLayout.VERTICAL);
        copy.setPadding(dp(8), 0, dp(4), 0);
        TextView title = text(name, 15, true); title.setSingleLine(true); title.setEllipsize(TextUtils.TruncateAt.END);
        TextView status = text("ARCHIVED", 11, true); status.setTextColor(MUTED);
        copy.addView(title, new LinearLayout.LayoutParams(-1, dp(28)));
        copy.addView(status, new LinearLayout.LayoutParams(-1, dp(22)));
        row.addView(copy, new LinearLayout.LayoutParams(0, -1, 1));
        Button unarchive = button("Unarchive", false); unarchive.setTextColor(ACCENT); unarchive.setTextSize(11);
        unarchive.setContentDescription("Unarchive thread " + name);
        unarchive.setOnClickListener(v -> unarchiveAgent(id, name));
        row.addView(unarchive, new LinearLayout.LayoutParams(dp(88), dp(44)));
        return row;
    }

    private String shortPath(String cwd) {
        return cwd;
    }

    private String dot(String state) {
        if ("RUNNING".equals(state)) return "●";
        if ("FAILED".equals(state)) return "!";
        if ("STARTING".equals(state) || "ABORTING".equals(state)) return "…";
        return "○";
    }

    private boolean isWorking(String state) {
        return "RUNNING".equals(state) || "STARTING".equals(state) || "ABORTING".equals(state);
    }

    private String activityFromState(String state) {
        if ("FAILED".equals(state)) return "FAILED";
        if ("STARTING".equals(state)) return "STARTING";
        if ("ABORTING".equals(state)) return "ABORTING";
        if ("RUNNING".equals(state)) return "WORKING";
        return "IDLE";
    }

    private String activityLabel(String activity, String tool) {
        if ("WAITING_ON_TOOL".equals(activity))
            return tool == null || tool.isEmpty() ? "WAITING ON TOOL" : "WAITING ON " + tool.toUpperCase(Locale.ROOT);
        if ("THINKING".equals(activity)) return "THINKING";
        if ("COMPACTING".equals(activity)) return "COMPACTING";
        if ("RETRYING".equals(activity)) return "RETRYING";
        if ("QUEUED".equals(activity)) return "QUEUED";
        if ("WORKING".equals(activity)) return "WORKING";
        if ("STARTING".equals(activity)) return "STARTING";
        if ("ABORTING".equals(activity)) return "ABORTING";
        if ("FAILED".equals(activity)) return "FAILED";
        return "IDLE";
    }

    private boolean selectedActionInFlight() {
        return selectedId != null && actionTokens.containsKey(selectedId);
    }

    private String displayedActivity() {
        String action = selectedId == null ? null : actionTypes.get(selectedId);
        if ("abort".equals(action)) return "ABORTING";
        if ("send".equals(action) && !isWorking(selectedState)) return "QUEUED";
        return selectedActivity;
    }

    private String stateLabel() { return activityLabel(displayedActivity(), selectedTool); }

    private int activityColor(String activity) {
        if ("ABORTING".equals(activity) || "FAILED".equals(activity)) return DANGER;
        if (!"IDLE".equals(activity)) return ACCENT;
        return MUTED;
    }

    private int activityColor() { return activityColor(displayedActivity()); }

    private void updateTopBar() {
        if (agentRunId != null) {
            topTitle.setText(agentRunLabel + " · " + agentRunTask);
            topState.setText(observedStatusLabel());
            topState.setTextColor("running".equals(agentRunStatus) ? activityColor(agentRunActivity) : MUTED);
            settingsButton.setEnabled(false);
            return;
        }
        topTitle.setText(selectedId == null ? "Pi Remote" : selectedName);
        topState.setText(stateLabel());
        topState.setTextColor(activityColor());
        settingsButton.setEnabled(selectedId != null);
        if (settingsOpen) {
            settingsThread.setText("Thread " + selectedName);
            settingsActivity.setText(stateLabel()); settingsActivity.setTextColor(activityColor());
            settingsCwd.setText(selectedCwd);
        }
    }

    private boolean hasReadyAttachments() {
        for (Attachment file : attachments) if (!file.uploading && file.path != null) return true;
        return false;
    }

    private boolean attachmentsUploading() {
        for (Attachment file : attachments) if (file.uploading) return true;
        return false;
    }

    private void renderAttachments() {
        attachmentList.removeAllViews();
        for (Attachment file : attachments) {
            LinearLayout chip = new LinearLayout(this); chip.setGravity(Gravity.CENTER_VERTICAL);
            chip.setPadding(dp(9), 0, 0, 0); chip.setBackground(shape(SURFACE_2));
            TextView name = text(file.uploading ? file.name + " · uploading…" : file.name, 12, false);
            name.setTextColor(file.uploading ? MUTED : TEXT); name.setSingleLine(true);
            name.setMaxWidth(dp(210)); name.setEllipsize(TextUtils.TruncateAt.END);
            chip.addView(name, new LinearLayout.LayoutParams(-2, dp(32)));
            Button remove = button("×", false); remove.setTextColor(DANGER); remove.setTextSize(20);
            remove.setPadding(0, 0, 0, 0); remove.setGravity(Gravity.CENTER); remove.setIncludeFontPadding(false);
            remove.setBackgroundColor(Color.TRANSPARENT); remove.setEnabled(!file.uploading);
            remove.setContentDescription("Remove " + file.name);
            remove.setOnClickListener(v -> {
                file.removed = true; attachments.remove(file); renderAttachments(); updateComposer();
                if (file.storedName != null) network.execute(() -> deleteUploaded(file.storedName, file.sessionId, file.environment));
            });
            chip.addView(remove, new LinearLayout.LayoutParams(dp(32), dp(32)));
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-2, dp(32));
            if (attachmentList.getChildCount() > 0) params.leftMargin = dp(6);
            attachmentList.addView(chip, params);
        }
        attachmentScroll.setVisibility(attachments.isEmpty() ? View.GONE : View.VISIBLE);
    }

    private void clearAttachments(boolean deleteFiles) {
        attachmentGeneration++;
        List<Attachment> old = new ArrayList<>(attachments); attachments.clear();
        for (Attachment file : old) file.removed = true;
        renderAttachments();
        if (deleteFiles) for (Attachment file : old) if (file.storedName != null)
            network.execute(() -> deleteUploaded(file.storedName, file.sessionId, file.environment));
    }

    private void openFilePicker() {
        if (selectedId == null || attachmentsUploading()) return;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE); intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        startActivityForResult(intent, 41);
    }

    private void showPasteTextDialog() {
        if (selectedId == null || attachmentsUploading()) return;
        LinearLayout fields = new LinearLayout(this);
        fields.setOrientation(LinearLayout.VERTICAL);
        fields.setPadding(dp(18), dp(4), dp(18), 0);

        TextView nameLabel = text("DOCUMENT NAME", 11, true); nameLabel.setTextColor(MUTED);
        fields.addView(nameLabel, new LinearLayout.LayoutParams(-1, dp(30)));
        EditText name = new EditText(this);
        name.setSingleLine(true); name.setText("pasted-text.txt"); name.setSelectAllOnFocus(true);
        name.setFilters(new InputFilter[]{new InputFilter.LengthFilter(180)});
        name.setTextColor(TEXT); name.setTextSize(15); name.setBackground(outlined(SURFACE_2, SURFACE_2));
        name.setPadding(dp(10), 0, dp(10), 0);
        fields.addView(name, new LinearLayout.LayoutParams(-1, dp(48)));

        TextView contentLabel = text("TEXT", 11, true); contentLabel.setTextColor(MUTED);
        LinearLayout.LayoutParams contentLabelParams = new LinearLayout.LayoutParams(-1, dp(38));
        contentLabelParams.topMargin = dp(6); fields.addView(contentLabel, contentLabelParams);
        EditText content = new EditText(this);
        content.setHint("Paste text here"); content.setHintTextColor(MUTED); content.setTextColor(TEXT); content.setTextSize(15);
        content.setGravity(Gravity.TOP | Gravity.START); content.setMinLines(8); content.setMaxLines(14);
        content.setFilters(new InputFilter[]{new InputFilter.LengthFilter(200_000)});
        content.setVerticalScrollBarEnabled(true); content.setBackground(outlined(SURFACE_2, SURFACE_2));
        content.setPadding(dp(10), dp(10), dp(10), dp(10));
        content.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE
            | android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        fields.addView(content, new LinearLayout.LayoutParams(-1, dp(260)));

        AlertDialog dialog = new AlertDialog.Builder(this, AlertDialog.THEME_DEVICE_DEFAULT_DARK)
            .setTitle("Paste text document").setView(fields)
            .setNegativeButton("Cancel", null).setPositiveButton("Add document", null).create();
        dialog.setOnShowListener(x -> {
            dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setTextColor(ACCENT);
            Button add = dialog.getButton(AlertDialog.BUTTON_POSITIVE); add.setTextColor(ACCENT);
            add.setEnabled(false);
            content.addTextChangedListener(new TextWatcher() {
                public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
                public void onTextChanged(CharSequence s, int start, int before, int count) {
                    add.setEnabled(!s.toString().trim().isEmpty());
                }
                public void afterTextChanged(Editable s) {}
            });
            add.setOnClickListener(v -> {
                String value = content.getText().toString();
                if (value.trim().isEmpty()) return;
                queueTextAttachment(name.getText().toString(), value);
                dialog.dismiss();
            });
            if (dialog.getWindow() != null) {
                dialog.getWindow().setBackgroundDrawable(shape(SURFACE));
                dialog.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
                    | WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE);
            }
            content.requestFocus();
        });
        dialog.show();
    }

    private String attachmentName(Uri uri) {
        try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                String value = cursor.getString(0); if (value != null && !value.trim().isEmpty()) return value;
            }
        } catch (Exception ignored) {}
        String fallback = uri.getLastPathSegment(); return fallback == null ? "attachment" : fallback;
    }

    private Attachment beginAttachment(String name) {
        Attachment file = new Attachment(); file.name = name; file.sessionId = selectedId; file.uploading = true;
        file.generation = attachmentGeneration; attachments.add(file); renderAttachments(); updateComposer();
        haptics.play(Haptics.Feel.ATTACH);
        return file;
    }

    private void queueAttachmentUpload(Attachment file, Callable<JSONObject> upload) {
        network.execute(() -> {
            try {
                JSONObject stored = upload.call();
                file.path = stored.optString("path"); file.storedName = stored.optString("name");
                file.environment = stored.optString("environment", "local"); file.uploading = false;
                if (file.removed || file.generation != attachmentGeneration) {
                    if (file.storedName != null) deleteUploaded(file.storedName, file.sessionId, file.environment);
                    main.post(() -> { attachments.remove(file); renderAttachments(); updateComposer(); });
                } else main.post(() -> {
                    renderAttachments(); updateComposer(); haptics.play(Haptics.Feel.UPLOADED);
                });
            } catch (Exception error) {
                main.post(() -> {
                    attachments.remove(file); renderAttachments(); updateComposer();
                    haptics.play(Haptics.Feel.ERROR); note(shortError(error));
                });
            }
        });
    }

    private void queueAttachment(Uri uri) {
        Attachment file = beginAttachment(attachmentName(uri));
        queueAttachmentUpload(file, () -> uploadAttachment(uri, file.name, file.sessionId));
    }

    private void queueTextAttachment(String name, String text) {
        Attachment file = beginAttachment(TextDocument.fileName(name));
        byte[] content = TextDocument.utf8(text);
        queueAttachmentUpload(file, () -> uploadAttachment(
            new ByteArrayInputStream(content), file.name, file.sessionId, "text/plain; charset=utf-8"));
    }

    private JSONObject uploadAttachment(Uri uri, String name, String sessionId) throws Exception {
        String type = getContentResolver().getType(uri);
        String contentType = type == null ? "application/octet-stream" : type;
        try {
            return uploadAttachment(openAttachment(uri), name, sessionId, contentType);
        } catch (PiRemoteApi.Locked locked) {
            // The upload body is already spent, so this reopens the file rather
            // than retrying the request. Uploads are the one call that cannot be
            // replayed from inside PiRemoteApi.
            PiRemoteKey.ensureUnlocked();
            return uploadAttachment(openAttachment(uri), name, sessionId, contentType);
        }
    }

    private InputStream openAttachment(Uri uri) throws IOException {
        InputStream input = getContentResolver().openInputStream(uri);
        if (input == null) throw new IOException("Could not open attachment");
        return input;
    }

    private JSONObject uploadAttachment(InputStream input, String name, String sessionId, String type) throws Exception {
        URL url = new URL(BuildConfig.SERVER_URL + "/v1/uploads?name=" + URLEncoder.encode(name, "UTF-8")
            + "&sessionId=" + URLEncoder.encode(sessionId, "UTF-8"));
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        try {
            connection.setRequestMethod("POST"); connection.setDoOutput(true); connection.setConnectTimeout(20_000);
            connection.setReadTimeout(120_000); connection.setChunkedStreamingMode(64 * 1024);
            connection.setRequestProperty("Content-Type", type);
            try (input; OutputStream output = connection.getOutputStream()) {
                byte[] buffer = new byte[64 * 1024];
                for (int count; (count = input.read(buffer)) >= 0;) if (count > 0) output.write(buffer, 0, count);
            }
            int code = connection.getResponseCode();
            String response = read(code >= 400 ? connection.getErrorStream() : connection.getInputStream());
            if (code == 423) throw new PiRemoteApi.Locked("Locked");
            if (code < 200 || code >= 300) throw new IOException(new JSONObject(response).optString("error", "Upload failed"));
            return new JSONObject(response).getJSONObject("file");
        } finally { connection.disconnect(); }
    }

    private void deleteUploaded(String name, String sessionId, String environment) {
        try { api("DELETE", "/v1/uploads?name=" + URLEncoder.encode(name, "UTF-8")
            + "&sessionId=" + URLEncoder.encode(sessionId, "UTF-8")
            + "&environment=" + URLEncoder.encode(environment == null ? "local" : environment, "UTF-8"), null); }
        catch (Exception ignored) {}
    }

    private void updateQueueStatus() {
        List<String> parts = new ArrayList<>();
        if (selectedSteeringQueued > 0) parts.add(selectedSteeringQueued + " steering after current tool calls");
        if (selectedFollowUpQueued > 0) parts.add(selectedFollowUpQueued + " queued for after completion");
        queueStatus.setText(String.join(" · ", parts));
        queueStatus.setVisibility(parts.isEmpty() ? View.GONE : View.VISIBLE);
    }

    private String queuedPreview(String value) {
        if (value == null) return "Attached files";
        for (String line : value.split("\\n")) if (!line.trim().isEmpty()) return line.trim();
        return "Attached files";
    }

    private Button queuedAction(String label, int color, String description) {
        Button action = button(label, false); action.setTextColor(color); action.setTextSize(9);
        action.setPadding(dp(6), 0, dp(6), 0); action.setMinWidth(0); action.setMinimumWidth(0);
        action.setContentDescription(description);
        return action;
    }

    private void setQueuedActionsEnabled(LinearLayout actions, boolean enabled) {
        for (int i = 0; i < actions.getChildCount(); i++) actions.getChildAt(i).setEnabled(enabled);
    }

    private void renderMessageQueue() {
        messageQueueList.removeAllViews();
        for (int i = 0; i < selectedQueuedMessages.length(); i++) {
            JSONObject message = selectedQueuedMessages.optJSONObject(i); if (message == null) continue;
            LinearLayout row = new LinearLayout(this); row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(dp(11), dp(5), dp(7), dp(5)); row.setBackground(outlined(SURFACE, SURFACE_2));
            LinearLayout copy = new LinearLayout(this); copy.setOrientation(LinearLayout.VERTICAL);
            String messageStatus = message.optString("status");
            if (messageStatus.isEmpty()) messageStatus = "followUp".equals(message.optString("delivery")) ? "Queued for after completion" : "Queued";
            TextView label = text(messageStatus.toUpperCase(Locale.ROOT), 10, true); label.setTextColor(MUTED);
            TextView preview = text(queuedPreview(message.optString("text")), 12, false);
            preview.setSingleLine(true); preview.setEllipsize(TextUtils.TruncateAt.END);
            copy.addView(label, new LinearLayout.LayoutParams(-1, dp(18)));
            copy.addView(preview, new LinearLayout.LayoutParams(-1, dp(22)));
            row.addView(copy, new LinearLayout.LayoutParams(0, dp(40), 1));
            LinearLayout actions = new LinearLayout(this); actions.setGravity(Gravity.CENTER_VERTICAL);
            boolean canSteer = message.has("canSteer") ? message.optBoolean("canSteer") : "followUp".equals(message.optString("delivery"));
            if (canSteer) {
                Button steer = queuedAction("STEER", ACCENT, "Steer queued message instead");
                steer.setOnClickListener(v -> steerQueuedMessage(message.optString("id"), actions));
                actions.addView(steer, new LinearLayout.LayoutParams(dp(54), dp(32)));
            }
            if (message.optBoolean("canCancel")) {
                Button edit = queuedAction("EDIT", ACCENT, "Cancel and edit queued message");
                edit.setOnClickListener(v -> cancelQueuedMessage(message.optString("id"), message.optString("text"), true, actions));
                actions.addView(edit, new LinearLayout.LayoutParams(dp(44), dp(32)));
                Button cancel = queuedAction("CANCEL", DANGER, "Cancel queued message");
                cancel.setOnClickListener(v -> cancelQueuedMessage(message.optString("id"), message.optString("text"), false, actions));
                actions.addView(cancel, new LinearLayout.LayoutParams(dp(60), dp(32)));
            }
            if (actions.getChildCount() > 0) row.addView(actions, new LinearLayout.LayoutParams(-2, dp(32)));
            messageQueueList.addView(row, new LinearLayout.LayoutParams(-1, dp(48)));
        }
        int count = messageQueueList.getChildCount();
        LinearLayout.LayoutParams params = (LinearLayout.LayoutParams) messageQueueScroll.getLayoutParams();
        params.height = dp(Math.min(160, count * 48)); messageQueueScroll.setLayoutParams(params);
        messageQueueScroll.setVisibility(count == 0 ? View.GONE : View.VISIBLE);
    }

    private void steerQueuedMessage(String workId, LinearLayout actions) {
        String id = selectedId;
        if (id == null || workId == null || workId.isEmpty()) return;
        setQueuedActionsEnabled(actions, false);
        network.execute(() -> {
            try {
                JSONObject result = api("POST", "/v1/sessions/" + id + "/queue/" + workId + "/steer", new JSONObject());
                main.post(() -> {
                    if (Objects.equals(selectedId, id)) applySelectedSnapshot(result.optJSONObject("session"), false);
                    haptics.play(Haptics.Feel.CONFIRM);
                    updateComposer(); refresh();
                });
            } catch (Exception error) {
                main.post(() -> {
                    haptics.play(Haptics.Feel.ERROR);
                    note(shortError(error)); setQueuedActionsEnabled(actions, true); refresh();
                });
            }
        });
    }

    private void cancelQueuedMessage(String workId, String queuedText, boolean edit, LinearLayout actions) {
        String id = selectedId;
        if (id == null || workId == null || workId.isEmpty()) return;
        setQueuedActionsEnabled(actions, false);
        network.execute(() -> {
            try {
                JSONObject result = api("DELETE", "/v1/sessions/" + id + "/queue/" + workId, null);
                main.post(() -> {
                    if (Objects.equals(selectedId, id)) {
                        applySelectedSnapshot(result.optJSONObject("session"), false);
                        if (edit) {
                            String restored = result.optString("text", queuedText);
                            prompt.setText(PromptComposer.restoreDraft(restored, prompt.getText().toString()));
                            prompt.setSelection(prompt.getText().length());
                            prompt.requestFocus();
                        }
                    }
                    haptics.play(Haptics.Feel.DETACH);
                    updateComposer(); refresh();
                });
            } catch (Exception error) {
                main.post(() -> {
                    haptics.play(Haptics.Feel.ERROR);
                    note(shortError(error)); setQueuedActionsEnabled(actions, true); refresh();
                });
            }
        });
    }

    private String slashToken() {
        if (prompt == null) return null;
        String value = prompt.getText().toString();
        if (!value.startsWith("/") || value.contains("\n") || value.matches(".*\\s.*")) return null;
        return value.substring(1);
    }

    private JSONObject recognizedCommand() {
        if (prompt == null) return null;
        String value = prompt.getText().toString().trim();
        if (!value.startsWith("/") || value.contains("\n")) return null;
        String commandText = value.substring(1);
        int space = -1;
        for (int i = 0; i < commandText.length(); i++) {
            if (Character.isWhitespace(commandText.charAt(i))) { space = i; break; }
        }
        String name = space < 0 ? commandText : commandText.substring(0, space);
        if (name.isEmpty()) return null;
        for (int i = 0; i < availableCommands.length(); i++) {
            JSONObject command = availableCommands.optJSONObject(i);
            if (command != null && name.equalsIgnoreCase(command.optString("name"))) return command;
        }
        return null;
    }

    private void renderSlashCommands() {
        if (slashCommandList == null) return;
        slashCommandList.removeAllViews();
        String token = slashToken();
        if (token == null) { slashCommandList.setVisibility(View.GONE); return; }
        int shown = 0;
        for (int i = 0; i < availableCommands.length(); i++) {
            JSONObject command = availableCommands.optJSONObject(i);
            if (command == null) continue;
            String name = command.optString("name");
            if (!PromptComposer.commandListed(name, command.optString("source"))) continue;
            if (!PromptComposer.commandMatches(name, token)) continue;
            Button choice = button(PromptComposer.commandLabel(
                name, command.optString("description"), command.optString("source")
            ), false);
            choice.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
            choice.setTextSize(13); choice.setTextColor(TEXT); choice.setPadding(dp(10), 0, dp(10), 0);
            choice.setContentDescription("Slash command /" + name);
            choice.setOnClickListener(v -> {
                prompt.setText("/" + name + " ");
                prompt.setSelection(prompt.length()); prompt.requestFocus();
                renderSlashCommands(); updateComposer();
            });
            slashCommandList.addView(choice, new LinearLayout.LayoutParams(-1, dp(42)));
            shown++;
        }
        slashCommandList.setVisibility(shown == 0 ? View.GONE : View.VISIBLE);
    }

    private void refreshCommands() {
        String id = selectedId;
        availableCommands = new JSONArray(); renderSlashCommands();
        if (id == null) return;
        network.execute(() -> {
            try {
                JSONObject result = api("GET", "/v1/sessions/" + id + "/commands", null);
                JSONArray commands = result.optJSONArray("commands");
                main.post(() -> {
                    if (!Objects.equals(selectedId, id)) return;
                    availableCommands = commands == null ? new JSONArray() : commands;
                    renderSlashCommands(); updateComposer();
                });
            } catch (Exception error) {
                main.post(() -> { if (Objects.equals(selectedId, id)) note("Could not load slash commands: " + shortError(error)); });
            }
        });
    }

    private void runCommand(JSONObject command) {
        if (selectedActionInFlight() || selectedId == null || command == null) return;
        String value = prompt.getText().toString().trim();
        String name = command.optString("name");
        String commandText = value.substring(1);
        int separator = -1;
        for (int i = 0; i < commandText.length(); i++) {
            if (Character.isWhitespace(commandText.charAt(i))) { separator = i; break; }
        }
        String typedName = separator < 0 ? commandText : commandText.substring(0, separator);
        String args = separator < 0 ? "" : commandText.substring(separator).trim();
        String id = selectedId;
        prompt.setText("");
        long actionToken = beginAction(id, "command");
        try {
            JSONObject body = new JSONObject().put("requestId", UUID.randomUUID().toString())
                .put("name", name).put("args", args);
            network.execute(() -> {
                Exception failure = null; JSONObject result = null;
                try { result = api("POST", "/v1/sessions/" + id + "/command", body); }
                catch (Exception error) { failure = error; }
                Exception error = failure; JSONObject response = result;
                main.post(() -> {
                    finishAction(id, actionToken);
                    if (error != null) {
                        if (Objects.equals(selectedId, id) && prompt.getText().toString().trim().isEmpty()) prompt.setText(value);
                        haptics.play(Haptics.Feel.ERROR);
                        note(shortError(error));
                    } else {
                        if (response != null && Objects.equals(selectedId, id)) applySelectedSnapshot(response.optJSONObject("session"), false);
                        haptics.play(Haptics.Feel.CONFIRM);
                    }
                    updateComposer(); updateTopBar(); refresh();
                });
            });
        } catch (JSONException error) { finishAction(id, actionToken); note(shortError(error)); }
    }

    private void updateComposer() {
        // Observing an autonomous agent is read-only: the orchestrator owns its
        // work, so no composer, attachment, queue, or voice control is offered.
        if (agentRunId != null) {
            composerBox.setVisibility(View.GONE);
            attachmentScroll.setVisibility(View.GONE);
            queueStatus.setVisibility(View.GONE);
            messageQueueScroll.setVisibility(View.GONE);
            slashCommandList.setVisibility(View.GONE);
            agentBanner.setVisibility(View.VISIBLE);
            agentBanner.setText(AgentRunView.banner(agentRunLabel, agentRunTask, agentRunStatus, agentRunProvider, agentRunElapsedMs));
            return;
        }
        composerBox.setVisibility(View.VISIBLE);
        agentBanner.setVisibility(View.GONE);
        boolean acting = selectedActionInFlight();
        String action = selectedId == null ? null : actionTypes.get(selectedId);
        boolean working = isWorking(selectedState) || "send".equals(action);
        boolean aborting = "ABORTING".equals(selectedState) || "abort".equals(action);
        boolean hasDraft = prompt != null && !prompt.getText().toString().trim().isEmpty();
        boolean canSubmit = hasDraft || hasReadyAttachments();
        boolean uploading = attachmentsUploading();
        boolean send = "send".equals(action) || !working || canSubmit;
        actionButton.setCompoundDrawablesWithIntrinsicBounds(send ? R.drawable.ic_send : R.drawable.ic_stop, 0, 0, 0);
        actionButton.setBackground(shape(send ? ACCENT : DANGER));
        // Send and stop are opposite intents; the swap between them is worth seeing happen.
        if (send != composerWasSending) {
            composerWasSending = send;
            actionButton.setScaleX(0.72f); actionButton.setScaleY(0.72f);
            actionButton.setRotation(send ? -22f : 22f);
            Springs.scale(actionButton, 1f, Springs.POP_STIFFNESS, 0.42f);
            Springs.to(actionButton, DynamicAnimation.ROTATION, 0f, Springs.POP_STIFFNESS, 0.42f);
        }
        actionButton.setEnabled(!acting && !uploading && (send ? canSubmit : !aborting));
        feelComposerArmed(canSubmit, acting);
        JSONObject command = recognizedCommand();
        actionButton.setContentDescription(aborting ? "Aborting agent" : command != null ? "Run slash command " + command.optString("name") : send
            ? (working ? "Queue message for later" : "Send message") : "Abort agent");
        attachButton.setEnabled(selectedId != null && !uploading);
        pasteTextButton.setEnabled(selectedId != null && !uploading);
        voiceButton.setEnabled(selectedId != null);
        prompt.setHint("Message " + selectedName + " · it can delegate tasks");
        renderSlashCommands();
        updateQueueStatus();
    }

    /**
     * The composer coming to life under a first character, and going quiet again. Suppressed
     * while an action is in flight, because clearing the box after a send is part of the send.
     */
    private void feelComposerArmed(boolean armed, boolean acting) {
        if (armed == feltComposerArmed) return;
        feltComposerArmed = armed;
        if (acting && !armed) return;
        haptics.play(armed ? Haptics.Feel.ARM : Haptics.Feel.DISARM);
    }

    private boolean applySelectedSnapshot(JSONObject session, boolean force) {
        if (session == null || !session.optString("id").equals(selectedId)) return false;
        long revision = session.optLong("revision");
        if (!force && revision < selectedRevision) return false;
        selectedRevision = revision;
        selectedName = session.optString("name", "Agent");
        selectedCwd = session.optString("cwd", "/");
        selectedState = session.optString("state", "STOPPED");
        selectedActivity = session.optString("activity", activityFromState(selectedState));
        selectedTool = session.optString("activeTool", "");
        selectedSteeringQueued = session.optInt("steeringQueued");
        selectedFollowUpQueued = session.optInt("followUpQueued");
        selectedQueuedMessages = session.optJSONArray("queuedMessages") == null ? new JSONArray() : session.optJSONArray("queuedMessages");
        renderMessageQueue();
        return true;
    }

    private long beginAction(String id, String type) {
        long token = ++actionGeneration;
        actionTokens.put(id, token); actionTypes.put(id, type);
        updateComposer(); updateTopBar();
        return token;
    }

    private void finishAction(String id, long token) {
        if (Objects.equals(actionTokens.get(id), token)) {
            actionTokens.remove(id); actionTypes.remove(id);
        }
        actionGeneration++;
    }

    private void select(String id, String name, String cwd, String state, String activity, String activeTool, long revision,
                        int steeringQueued, int followUpQueued, JSONArray queuedMessages) {
        boolean changed = !Objects.equals(selectedId, id) || agentRunId != null;
        // Opening a thread always leaves agent observation.
        agentRunId = null;
        if (changed) {
            selectionGeneration++;
            selectedId = id; selectedRevision = revision;
            refreshCommands();
        }
        try {
            applySelectedSnapshot(new JSONObject().put("id", id).put("name", name).put("cwd", cwd)
                .put("state", state).put("activity", activity).put("activeTool", activeTool).put("revision", revision)
                .put("steeringQueued", steeringQueued).put("followUpQueued", followUpQueued)
                .put("queuedMessages", queuedMessages == null ? new JSONArray() : queuedMessages), changed);
        } catch (JSONException ignored) {}
        if (changed) {
            resetTranscript(); prompt.setText(loadDraft(id)); clearAttachments(true);
            renderAgentSection();
        }
        detail.setVisibility(View.VISIBLE); emptyBox.setVisibility(View.GONE); updateComposer(); updateTopBar();
        publishOpenThread();
        refresh();
    }

    private void clearSelection() {
        selectionGeneration++;
        selectedId = null; selectedState = "STOPPED"; selectedActivity = "IDLE"; selectedTool = ""; selectedRevision = 0;
        selectedSteeringQueued = 0; selectedFollowUpQueued = 0; selectedQueuedMessages = new JSONArray(); renderMessageQueue(); lastSeq = 0;
        availableCommands = new JSONArray(); renderSlashCommands();
        resetTranscript();
        detail.setVisibility(View.GONE); prompt.setText(""); clearAttachments(true); updateTopBar();
        publishOpenThread();
    }

    private void saveDraft() {
        if (prompt == null || selectedId == null) return;
        String value = prompt.getText().toString();
        android.content.SharedPreferences.Editor editor = getSharedPreferences(DRAFT_PREFS, MODE_PRIVATE).edit();
        if (value.isEmpty()) editor.remove(selectedId); else editor.putString(selectedId, value);
        editor.apply();
    }

    private String loadDraft(String sessionId) {
        return getSharedPreferences(DRAFT_PREFS, MODE_PRIVATE).getString(sessionId, "");
    }

    private static class Attachment {
        String name;
        String storedName;
        String sessionId;
        String environment;
        String path;
        boolean uploading;
        boolean removed;
        long generation;
    }

    private static class ToolCard {
        LinearLayout root;
        TextView header;
        TextView body;
        TextView timing;
        TextView toggle;
        boolean expandable;
        boolean expanded;
        boolean finished;
        boolean delegated;
        long startedAtMs;
        long endedAtMs;
        long timeoutMs = -1;
        Runnable ticker;
    }

    private void addTranscriptView(View view, int topMargin) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.topMargin = dp(topMargin);
        transcript.addView(view, params);
        // Backfilling a thread is not an arrival, so only what lands after it is settled rises in.
        if (transcript.getChildCount() > 1 && SystemClock.uptimeMillis() - transcriptOpenedMs > 700)
            Springs.enter(view, dp(14));
        while (transcript.getChildCount() > 50) {
            View removed = transcript.getChildAt(0);
            transcript.removeViewAt(0);
            Iterator<Map.Entry<String, ToolCard>> iterator = toolCards.entrySet().iterator();
            while (iterator.hasNext()) if (iterator.next().getValue().root == removed) iterator.remove();
        }
    }

    /** A transcript entry: a label over a body that may not have stopped growing. */
    private static final class Message {
        LinearLayout root;
        TextView label;
        MarkdownStream body;
    }

    private Message message(String label, int color) {
        Message message = new Message();
        message.root = new LinearLayout(this); message.root.setOrientation(LinearLayout.VERTICAL);
        message.label = text(label.toUpperCase(Locale.ROOT), 11, true);
        message.label.setGravity(Gravity.TOP); message.label.setTextColor(color);
        message.root.addView(message.label);
        message.body = markdown(16, TEXT); message.body.setLineSpacing(0, 1.08f);
        message.root.addView(message.body, new LinearLayout.LayoutParams(-1, -2));
        addTranscriptView(message.root, transcript.getChildCount() == 0 ? 0 : 22);
        return message;
    }

    private void appendMessage(String label, String value, int color) { appendMessage(label, value, color, 0); }

    private void appendMessage(String label, String value, int color, long eventSeq) {
        Message message = message(label, color);
        if (eventSeq > 0) userMessageLabels.put(eventSeq, message.label);
        message.body.setSource(value);
    }

    private String formatJson(Object value) {
        if (value == null || value == JSONObject.NULL) return "";
        try {
            if (value instanceof JSONObject) return ((JSONObject) value).toString(2);
            if (value instanceof JSONArray) return ((JSONArray) value).toString(2);
        } catch (JSONException ignored) {}
        return String.valueOf(value);
    }

    private String toolCallSummary(String name, JSONObject args) {
        String tool = name.isEmpty() ? "tool" : name.toLowerCase(Locale.ROOT);
        String path = args.optString("path", args.optString("file_path", ""));
        if ("bash".equals(tool)) return "$ " + args.optString("command", "");
        if ("read".equals(tool)) {
            String range = "";
            if (args.has("offset") || args.has("limit")) {
                int start = args.optInt("offset", 1);
                range = ":" + start + (args.has("limit") ? "-" + (start + args.optInt("limit") - 1) : "");
            }
            return "read " + shortPath(path) + range;
        }
        if ("edit".equals(tool)) {
            int changes = args.optJSONArray("edits") == null ? 1 : args.optJSONArray("edits").length();
            return "edit " + shortPath(path) + (changes > 1 ? " · " + changes + " changes" : "");
        }
        if ("write".equals(tool)) return "write " + shortPath(path);
        if ("delegate".equals(tool)) {
            String task = args.optString("task").replaceAll("\\s+", " ").trim();
            return "Nested agent · " + (task.isEmpty() ? "delegated task" : task);
        }
        if ("grep".equals(tool)) return "grep /" + args.optString("pattern") + "/ in " + shortPath(path.isEmpty() ? "." : path);
        if ("find".equals(tool)) return "find " + args.optString("pattern") + " in " + shortPath(path.isEmpty() ? "." : path);
        if ("ls".equals(tool)) return "ls " + shortPath(path.isEmpty() ? "." : path);
        return tool;
    }

    private String toolInputBody(String name, JSONObject args) {
        String tool = name.toLowerCase(Locale.ROOT);
        if ("write".equals(tool)) return args.optString("content");
        if ("edit".equals(tool)) {
            JSONArray edits = args.optJSONArray("edits");
            if (edits == null) return "";
            StringBuilder preview = new StringBuilder();
            for (int i = 0; i < Math.min(edits.length(), 3); i++) {
                JSONObject edit = edits.optJSONObject(i); if (edit == null) continue;
                if (preview.length() > 0) preview.append("\n");
                preview.append("− ").append(edit.optString("oldText")).append("\n+ ").append(edit.optString("newText"));
            }
            if (edits.length() > 3) preview.append("\n… ").append(edits.length() - 3).append(" more changes");
            return preview.toString();
        }
        if ("delegate".equals(tool)) {
            String cwd = args.has("cwd") ? args.optString("cwd") : "Inherited from parent";
            return "Task\n" + args.optString("task") + "\n\nWorking directory\n" + cwd;
        }
        if (Arrays.asList("bash", "read", "grep", "find", "ls").contains(tool)) return "";
        return formatJson(args);
    }

    private TextView toolText(String value, int color, boolean bold) {
        TextView view = text(value, 14, bold);
        view.setGravity(Gravity.TOP); view.setTextColor(color);
        view.setTypeface(Typeface.MONOSPACE, bold ? Typeface.BOLD : Typeface.NORMAL);
        makeSelectable(view); view.setLineSpacing(0, 1.04f);
        return view;
    }

    private boolean exceedsPreviewLines(TextView view, int previewLines) {
        int width = view.getWidth() - view.getPaddingLeft() - view.getPaddingRight();
        CharSequence value = view.getText();
        if (width <= 0 || value == null || value.length() == 0) return false;
        StaticLayout fullLayout = StaticLayout.Builder.obtain(value, 0, value.length(), view.getPaint(), width)
            .setAlignment(Layout.Alignment.ALIGN_NORMAL)
            .setIncludePad(view.getIncludeFontPadding())
            .setLineSpacing(view.getLineSpacingExtra(), view.getLineSpacingMultiplier())
            .build();
        return fullLayout.getLineCount() > previewLines;
    }

    private void setToolExpanded(ToolCard card, boolean expanded) {
        card.expanded = expanded;
        // maxLines alone still lets part of a newline's next glyph row bleed through on
        // selectable Android TextViews. Single-line mode gives the collapsed header a
        // genuinely one-line layout; expanded mode restores normal wrapping.
        card.header.setSingleLine(!expanded);
        if (expanded) card.header.setHorizontallyScrolling(false);
        card.header.setMaxLines(expanded ? Integer.MAX_VALUE : TOOL_HEADER_PREVIEW_LINES);
        card.header.setEllipsize(expanded ? null : TextUtils.TruncateAt.END);
        card.body.setMaxLines(expanded ? Integer.MAX_VALUE : TOOL_PREVIEW_LINES);
        card.body.setEllipsize(expanded ? null : TextUtils.TruncateAt.END);
        card.toggle.setText(expanded ? "Show less" : "Show more");
        card.toggle.setContentDescription(expanded ? "Collapse tool details" : "Expand tool details");
        card.toggle.setVisibility(card.expandable ? View.VISIBLE : View.GONE);
        card.root.requestLayout();
    }

    private void refreshToolExpansionControl(ToolCard card) {
        card.body.setVisibility(card.body.getText().length() == 0 ? View.GONE : View.VISIBLE);
        if (card.expanded) return;
        card.expandable = false;
        card.toggle.setVisibility(View.GONE);
        card.root.post(() -> {
            if (card.expanded) return;
            card.expandable = exceedsPreviewLines(card.header, TOOL_HEADER_PREVIEW_LINES)
                || (card.body.getVisibility() == View.VISIBLE && exceedsPreviewLines(card.body, TOOL_PREVIEW_LINES));
            card.toggle.setVisibility(card.expandable ? View.VISIBLE : View.GONE);
        });
    }

    private long toolEventTime(String value) {
        try { return java.time.Instant.parse(value).toEpochMilli(); }
        catch (Exception ignored) { return System.currentTimeMillis(); }
    }

    private String duration(long millis) {
        long seconds = Math.max(0, millis / 1000);
        if (seconds < 60) return seconds + "s";
        long minutes = seconds / 60;
        if (minutes < 60) return minutes + "m " + (seconds % 60) + "s";
        return (minutes / 60) + "h " + (minutes % 60) + "m";
    }

    private void updateToolTiming(ToolCard card) {
        long end = card.finished ? card.endedAtMs : System.currentTimeMillis();
        String started = new SimpleDateFormat("MMM d, HH:mm:ss", Locale.getDefault()).format(new Date(card.startedAtMs));
        String timeout = card.timeoutMs >= 0 ? "timeout " + duration(card.timeoutMs) : "no timeout";
        card.timing.setText("Started " + started + " · " + (card.finished ? "ran " : "elapsed ")
            + duration(end - card.startedAtMs) + " · " + timeout);
    }

    private void startTool(String id, String name, JSONObject args, String startedAt) {
        ToolCard card = new ToolCard();
        card.delegated = "delegate".equalsIgnoreCase(name);
        card.startedAtMs = toolEventTime(startedAt);
        if (args.has("timeoutMs")) card.timeoutMs = Math.max(0, args.optLong("timeoutMs"));
        else if (args.has("timeout")) card.timeoutMs = Math.max(0, Math.round(args.optDouble("timeout") * 1000));
        card.root = new LinearLayout(this); card.root.setOrientation(LinearLayout.VERTICAL);
        card.root.setPadding(dp(12), dp(10), dp(12), dp(10));
        card.root.setBackground(shape(card.delegated ? DELEGATE_PENDING : TOOL_PENDING));
        if (card.delegated) card.root.setContentDescription("Nested agent delegation");
        card.header = toolText("…  " + toolCallSummary(name, args), card.delegated ? DELEGATE : ACCENT, true);
        card.root.addView(card.header);
        card.timing = text("", 12, false); card.timing.setTextColor(MUTED); makeSelectable(card.timing);
        card.timing.setPadding(0, dp(5), 0, 0); card.root.addView(card.timing, new LinearLayout.LayoutParams(-1, dp(28)));
        String input = toolInputBody(name, args);
        card.body = toolText(input, TEXT, false);
        LinearLayout.LayoutParams bodyParams = new LinearLayout.LayoutParams(-1, -2); bodyParams.topMargin = dp(8);
        card.root.addView(card.body, bodyParams);
        card.toggle = text("Show more", 13, true);
        card.toggle.setTextColor(ACCENT); card.toggle.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        card.toggle.setPadding(0, dp(8), 0, 0); card.toggle.setVisibility(View.GONE);
        card.toggle.setOnClickListener(v -> {
            haptics.play(Haptics.Feel.SELECT, v);
            setToolExpanded(card, !card.expanded);
        });
        card.root.addView(card.toggle, new LinearLayout.LayoutParams(-1, dp(36)));
        setToolExpanded(card, false);
        toolCards.put(id, card);
        addTranscriptView(card.root, transcript.getChildCount() == 0 ? 0 : 18);
        refreshToolExpansionControl(card);
        updateToolTiming(card);
        card.ticker = new Runnable() {
            public void run() {
                if (card.finished || card.root.getParent() == null) return;
                updateToolTiming(card);
                main.postDelayed(this, 1000);
            }
        };
        main.postDelayed(card.ticker, 1000);
    }

    private void finishTool(String id, String name, String output, boolean error, String endedAt) {
        ToolCard card = toolCards.get(id);
        if (card == null) {
            startTool(id, name, new JSONObject(), endedAt);
            card = toolCards.get(id);
        }
        if (card == null) return;
        card.finished = true; card.endedAtMs = toolEventTime(endedAt);
        if (card.ticker != null) main.removeCallbacks(card.ticker);
        updateToolTiming(card);
        String header = card.header.getText().toString();
        card.header.setText((error ? "×" : "✓") + header.substring(header.indexOf("  ")));
        card.header.setTextColor(error ? DANGER : SUCCESS);
        card.root.setBackground(shape(error ? TOOL_ERROR : TOOL_SUCCESS));
        String body = output == null ? "" : output.trim();
        if (!body.isEmpty()) {
            String existing = card.body.getText().toString();
            if (!existing.isEmpty()) body = existing + "\n\n" + body;
            card.body.setText(body); card.body.setTextColor(error ? DANGER : TEXT);
        }
        refreshToolExpansionControl(card);
    }

    private MarkdownStream thought() {
        MarkdownStream thought = markdown(14, MUTED);
        thought.setTypeface(Typeface.DEFAULT, Typeface.ITALIC); thought.setLineSpacing(0, 1.05f);
        thought.setPadding(dp(12), dp(10), dp(12), dp(10)); thought.setBackground(shape(TOOL_PENDING));
        addTranscriptView(thought, transcript.getChildCount() == 0 ? 0 : 18);
        return thought;
    }

    private void renderEvents(JSONObject result) {
        JSONArray events = result.optJSONArray("events");
        boolean added = false;
        if (events != null) for (int i = 0; i < events.length(); i++) {
            JSONObject e = events.optJSONObject(i); if (e == null) continue;
            lastSeq = Math.max(lastSeq, e.optLong("seq"));
            String type = e.optString("type"), value = e.optString("text"), name = e.optString("name");
            if ("user".equals(type)) {
                String delivery = e.optString("delivery");
                String label = "steer".equals(delivery) ? "You · Steer" : "followUp".equals(delivery) ? "You · Later" : "You";
                appendMessage(label, value, ACCENT, e.optLong("seq"));
            }
            else if ("user_delivery".equals(type)) {
                TextView label = userMessageLabels.get(e.optLong("eventSeq"));
                if (label != null) label.setText("steer".equals(e.optString("delivery")) ? "YOU · STEER" : "YOU · LATER");
            }
            else if ("assistant".equals(type)) settleLive(value);
            else if ("tool_start".equals(type))
                startTool(e.optString("toolCallId"), name, e.optJSONObject("args") == null ? new JSONObject() : e.optJSONObject("args"), e.optString("time"));
            else if ("tool_end".equals(type))
                finishTool(e.optString("toolCallId"), name, e.optString("output"), e.optBoolean("error"), e.optString("time"));
            else if ("thinking".equals(type)) settleThinking(value);
            else if ("notice".equals(type)) appendMessage("Status", value, MUTED);
            added = true;
        }
        setLiveThinking(result.optString("liveThinking"));
        setLive(result.optString("liveText"));
    }

    /**
     * What Pi is saying right now is an ordinary transcript entry that has not stopped
     * growing, so it is written where it will finally stand and simply loses its working
     * label when the turn settles it. Held somewhere else and copied across at the end, it
     * would be rendered a second time from nothing at the one moment the reader is most
     * likely to be reading it, which is how a finished answer used to flash and re-flow.
     * An entry that never settles — an aborted turn — is taken back off the list.
     */
    private void setLive(String value) {
        String next = value == null ? "" : value;
        if (next.isEmpty()) {
            if (liveAnswer != null) transcript.removeView(liveAnswer.root);
            liveAnswer = null;
            return;
        }
        if (liveAnswer == null) liveAnswer = message("Pi · Working", SUCCESS);
        liveAnswer.body.setSource(next);
    }

    private void settleLive(String value) {
        if (liveAnswer == null) { appendMessage("Pi", value, SUCCESS); return; }
        Message settled = liveAnswer;
        liveAnswer = null;
        settled.label.setText("PI");
        settled.body.setSource(value);
    }

    private void setLiveThinking(String value) {
        String next = value == null ? "" : value;
        if (next.isEmpty()) {
            if (liveThought != null) transcript.removeView(liveThought);
            liveThought = null;
            return;
        }
        if (liveThought == null) liveThought = thought();
        liveThought.setSource(THINKING + next);
    }

    private void settleThinking(String value) {
        MarkdownStream settled = liveThought == null ? thought() : liveThought;
        liveThought = null;
        settled.setSource(THINKING + value);
    }

    private void newThread(String destination, String model) {
        try {
            JSONObject body = new JSONObject()
                .put("requestId", UUID.randomUUID().toString())
                .put("destination", destination);
            if (model != null) body.put("model", model);
            network.execute(() -> {
                try {
                    JSONObject s = api("POST", "/v1/sessions", body).getJSONObject("session");
                    main.post(() -> {
                        select(s.optString("id"), s.optString("name"), s.optString("cwd"), s.optString("state"),
                            s.optString("activity", activityFromState(s.optString("state"))), s.optString("activeTool"),
                            s.optLong("revision"), s.optInt("steeringQueued"), s.optInt("followUpQueued"), s.optJSONArray("queuedMessages"));
                        haptics.play(Haptics.Feel.IGNITE);
                        closeDrawer();
                    });
                } catch (Exception e) {
                    main.post(() -> haptics.play(Haptics.Feel.ERROR));
                    note(shortError(e));
                }
            });
        } catch (Exception e) { haptics.play(Haptics.Feel.ERROR); note(shortError(e)); }
    }

    private void openVoice() {
        if (selectedId == null) return;
        haptics.play(Haptics.Feel.VOICE_START);
        Intent intent = new Intent(this, VoiceActivity.class)
            .putExtra(VoiceActivity.EXTRA_SESSION_ID, selectedId)
            .putExtra(VoiceActivity.EXTRA_SESSION_NAME, selectedName);
        startActivity(intent);
    }

    private void sendPrompt(String delivery) {
        if (selectedActionInFlight()) return;
        JSONObject command = recognizedCommand();
        if (command != null && !hasReadyAttachments()) { runCommand(command); return; }
        String value = prompt.getText().toString().trim();
        List<Attachment> sentFiles = new ArrayList<>();
        for (Attachment file : attachments) if (!file.uploading && file.path != null) sentFiles.add(file);
        if ((value.isEmpty() && sentFiles.isEmpty()) || selectedId == null || "ABORTING".equals(selectedState)) return;
        List<String> attachmentPaths = new ArrayList<>();
        for (Attachment file : sentFiles) attachmentPaths.add(file.path);
        String sentText = PromptComposer.compose(value, attachmentPaths);
        String id = selectedId;
        prompt.setText(""); clearAttachments(false);
        // Sending is a statement that you want to see the answer.
        transcriptScroll.follow();
        haptics.play(Haptics.Feel.SEND);
        long actionToken = beginAction(id, "send");
        try {
            JSONObject body = new JSONObject().put("requestId", UUID.randomUUID().toString()).put("text", sentText).put("delivery", delivery);
            network.execute(() -> {
                Exception failure = null;
                JSONObject accepted = null;
                try { accepted = api("POST", "/v1/sessions/" + id + "/prompt", body); }
                catch (Exception first) {
                    // The request ID makes this retry safe if the first response was lost
                    // after the server had already committed the prompt.
                    try { Thread.sleep(500); accepted = api("POST", "/v1/sessions/" + id + "/prompt", body); }
                    catch (Exception second) { failure = second; }
                }
                Exception error = failure;
                JSONObject result = accepted;
                main.post(() -> {
                    finishAction(id, actionToken);
                    if (error != null && Objects.equals(selectedId, id)) {
                        if (prompt.getText().toString().trim().isEmpty()) prompt.setText(value);
                        for (Attachment file : sentFiles) { file.removed = false; file.generation = attachmentGeneration; }
                        attachments.addAll(0, sentFiles); renderAttachments();
                        haptics.play(Haptics.Feel.ERROR);
                        note(shortError(error));
                    } else if (result != null) {
                        JSONObject resultSession = result.optJSONObject("session");
                        String resultName = resultSession == null ? "Thread" : resultSession.optString("name", "Thread");
                        if (CompletionNotificationService.watchSession(this, id, resultName))
                            requestedCompletionWatches.add(id);
                        else requestedCompletionWatches.remove(id);
                        if (Objects.equals(selectedId, id)) applySelectedSnapshot(resultSession, false);
                        String acceptedDelivery = result.optString("delivery");
                        if ("steer".equals(acceptedDelivery) || "followUp".equals(acceptedDelivery))
                            haptics.play(Haptics.Feel.QUEUE);
                    }
                    updateComposer(); updateTopBar(); refresh();
                });
            });
        } catch (Exception e) { haptics.play(Haptics.Feel.ERROR); note(shortError(e)); }
    }

    private void abortSelected() {
        if (selectedId == null || !isWorking(selectedState) || "ABORTING".equals(selectedState) || selectedActionInFlight()) return;
        String id = selectedId;
        haptics.play(Haptics.Feel.ABORT);
        long actionToken = beginAction(id, "abort");
        abortNetwork.execute(() -> {
            Exception failure = null;
            JSONObject result = null;
            try { result = api("POST", "/v1/sessions/" + id + "/abort", new JSONObject()); }
            catch (Exception error) { failure = error; }
            Exception error = failure;
            JSONObject response = result;
            main.post(() -> {
                finishAction(id, actionToken);
                if (error != null) { haptics.play(Haptics.Feel.ERROR); note(shortError(error)); }
                else {
                    JSONObject session = response.optJSONObject("session");
                    if (session != null && isWorking(session.optString("state"))) {
                        if (CompletionNotificationService.watchSession(this, id, session.optString("name")))
                            requestedCompletionWatches.add(id);
                    } else {
                        requestedCompletionWatches.remove(id);
                        CompletionNotificationService.unwatchSession(this, id);
                    }
                    if (Objects.equals(selectedId, id)) applySelectedSnapshot(session, false);
                }
                updateComposer(); updateTopBar(); refresh();
            });
        });
    }

    private void archiveAgent(String id, String name, View foreground) {
        if (!archiveSupported) {
            Springs.to(foreground, DynamicAnimation.TRANSLATION_X, 0f, Springs.POP_STIFFNESS, Springs.POP_DAMPING);
            return;
        }
        network.execute(() -> {
            try {
                api("DELETE", "/v1/sessions/" + id, null);
                CompletionNotificationService.unwatchSession(this, id);
                CompletionNotificationService.clearCompletionNotification(this, id);
                requestedCompletionWatches.remove(id);
                main.post(() -> { if (id.equals(selectedId)) clearSelection(); refresh(); });
            } catch (Exception e) {
                main.post(() -> {
                    Springs.to(foreground, DynamicAnimation.TRANSLATION_X, 0f, Springs.POP_STIFFNESS, Springs.POP_DAMPING);
                    haptics.play(Haptics.Feel.ERROR);
                });
                note(shortError(e));
            }
        });
    }

    private void unarchiveAgent(String id, String name) {
        network.execute(() -> {
            try {
                JSONObject session = api("POST", "/v1/sessions/" + id + "/unarchive", new JSONObject())
                    .getJSONObject("session");
                main.post(() -> {
                    dropArchivedOlder(id);
                    select(session.optString("id"), session.optString("name", name), session.optString("cwd", "/"),
                        session.optString("state", "STOPPED"), session.optString("activity", "IDLE"),
                        session.optString("activeTool", ""), session.optLong("revision"), session.optInt("steeringQueued"),
                        session.optInt("followUpQueued"), session.optJSONArray("queuedMessages"));
                    haptics.play(Haptics.Feel.RESTORE);
                    closeDrawer(); refresh();
                });
            } catch (Exception e) {
                main.post(() -> haptics.play(Haptics.Feel.ERROR));
                note(shortError(e));
            }
        });
    }

    private JSONObject api(String method, String path, JSONObject body) throws Exception {
        return PiRemoteApi.request(method, path, body);
    }

    /** Whether the supervisor answered that the thread is gone, rather than failing to answer. */
    private boolean isMissing(Exception failure) {
        return String.valueOf(failure.getMessage()).contains("Session not found");
    }

    private String read(InputStream input) throws IOException {
        return PiRemoteApi.read(input);
    }

    private String shortError(Exception e) {
        String s = e.getMessage(); return s == null ? "Request failed" : s.replace(BuildConfig.SERVER_URL, "server");
    }

    /**
     * Records a failure where an agent reading logcat will find it. Failures used to arrive as
     * system toasts, which interrupt whatever is on screen to report things the reader cannot
     * act on, and cover the composer while doing it. What the user needs to know is already in
     * the surface itself: the connection row, the queue, the thread's own state, and haptics.
     */
    private void note(String value) { Log.w("PiRemote", value); }
}
