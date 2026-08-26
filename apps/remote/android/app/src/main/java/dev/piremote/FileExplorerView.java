package dev.piremote;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.BaseAdapter;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class FileExplorerView extends LinearLayout {
    interface Listener {
        void download(String path);
    }

    private static final String PREFERENCES = "file_explorer";
    private static final String PATH_KEY = "path";

    private static final class Entry {
        final String name;
        final String path;
        final String kind;

        Entry(JSONObject value) {
            name = value.optString("name");
            path = value.optString("path");
            kind = value.optString("kind", "other");
        }

        boolean directory() { return "directory".equals(kind); }
        boolean file() { return "file".equals(kind); }
    }

    private static final class Row {
        final ImageView icon;
        final TextView name;
        final TextView arrow;

        Row(ImageView icon, TextView name, TextView arrow) {
            this.icon = icon;
            this.name = name;
            this.arrow = arrow;
        }
    }

    private final Haptics haptics;
    private final Listener listener;
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<Entry> entries = new ArrayList<>();
    private final EntryAdapter adapter = new EntryAdapter();
    private final LinearLayout breadcrumbs;
    private final HorizontalScrollView breadcrumbScroll;
    private final Button up;
    private final ListView list;
    private final ProgressBar progress;
    private final LinearLayout messageBox;
    private final TextView message;
    private final Button retry;
    private final Button root;
    private String currentPath = "/";
    private long generation;
    private PiRemoteApi.Cancellation activeRequest;

    FileExplorerView(Context context, Haptics haptics, Listener listener) {
        super(context);
        this.haptics = haptics;
        this.listener = listener;
        setOrientation(VERTICAL);
        setBackgroundColor(PiRemoteColors.SURFACE);

        LinearLayout pathBar = new LinearLayout(context);
        pathBar.setGravity(Gravity.CENTER_VERTICAL);
        pathBar.setPadding(dp(6), dp(4), dp(6), dp(4));
        pathBar.setBackgroundColor(PiRemoteColors.SURFACE);

        up = actionButton("‹", "Go to parent folder");
        up.setTextSize(28);
        up.setOnClickListener(view -> navigate(FileNavigation.parent(currentPath)));
        pathBar.addView(up, new LayoutParams(dp(44), dp(44)));

        breadcrumbs = new LinearLayout(context);
        breadcrumbs.setOrientation(HORIZONTAL);
        breadcrumbs.setGravity(Gravity.CENTER_VERTICAL);
        breadcrumbScroll = new HorizontalScrollView(context);
        breadcrumbScroll.setHorizontalScrollBarEnabled(false);
        breadcrumbScroll.addView(breadcrumbs, new HorizontalScrollView.LayoutParams(-2, -1));
        pathBar.addView(breadcrumbScroll, new LayoutParams(0, dp(44), 1));

        Button refresh = actionButton("↻", "Refresh folder");
        refresh.setTextSize(22);
        refresh.setOnClickListener(view -> navigate(currentPath));
        pathBar.addView(refresh, new LayoutParams(dp(44), dp(44)));
        addView(pathBar, new LayoutParams(-1, dp(52)));

        FrameLayout body = new FrameLayout(context);
        list = new ListView(context);
        list.setAdapter(adapter);
        list.setDivider(new ColorDrawable(PiRemoteColors.SURFACE_2));
        list.setDividerHeight(dp(1));
        list.setSelector(android.R.color.transparent);
        list.setOnItemClickListener((parent, view, position, id) -> activate(entries.get(position)));
        list.setOnItemLongClickListener((parent, view, position, id) -> {
            copyPath(entries.get(position).path);
            return true;
        });
        body.addView(list, new FrameLayout.LayoutParams(-1, -1));

        progress = new ProgressBar(context);
        FrameLayout.LayoutParams progressParams = new FrameLayout.LayoutParams(dp(38), dp(38), Gravity.CENTER);
        body.addView(progress, progressParams);

        messageBox = new LinearLayout(context);
        messageBox.setOrientation(VERTICAL);
        messageBox.setGravity(Gravity.CENTER);
        messageBox.setPadding(dp(24), dp(24), dp(24), dp(24));
        message = label("", 15, false);
        message.setGravity(Gravity.CENTER);
        message.setTextColor(PiRemoteColors.MUTED);
        messageBox.addView(message, new LayoutParams(-1, -2));
        LinearLayout messageActions = new LinearLayout(context);
        messageActions.setGravity(Gravity.CENTER);
        retry = actionButton("Retry", "Retry folder");
        retry.setOnClickListener(view -> navigate(currentPath));
        messageActions.addView(retry, new LayoutParams(-2, dp(44)));
        root = actionButton("Go to /", "Go to root folder");
        root.setOnClickListener(view -> navigate("/"));
        LayoutParams rootParams = new LayoutParams(-2, dp(44));
        rootParams.leftMargin = dp(8);
        messageActions.addView(root, rootParams);
        LayoutParams actionParams = new LayoutParams(-2, dp(52));
        actionParams.topMargin = dp(12);
        messageBox.addView(messageActions, actionParams);
        body.addView(messageBox, new FrameLayout.LayoutParams(-1, -1));
        addView(body, new LayoutParams(-1, 0, 1));

        renderBreadcrumbs();
        showLoading();
    }

    void open() {
        String saved = getContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            .getString(PiRemoteEnvironment.scoped(PATH_KEY), "/");
        navigate(saved == null || !saved.startsWith("/") ? "/" : saved);
    }

    void environmentChanged() {
        generation++;
        if (activeRequest != null) activeRequest.cancel();
        activeRequest = null;
        currentPath = "/";
        entries.clear();
        adapter.notifyDataSetChanged();
        renderBreadcrumbs();
        showLoading();
    }

    boolean navigateBack() {
        if ("/".equals(currentPath)) return false;
        navigate(FileNavigation.parent(currentPath));
        return true;
    }

    void destroy() {
        generation++;
        if (activeRequest != null) activeRequest.cancel();
        activeRequest = null;
        network.shutdownNow();
    }

    private void navigate(String requestedPath) {
        if (requestedPath == null || !requestedPath.startsWith("/")) return;
        currentPath = requestedPath;
        renderBreadcrumbs();
        showLoading();
        if (activeRequest != null) activeRequest.cancel();
        PiRemoteApi.Cancellation cancellation = new PiRemoteApi.Cancellation();
        activeRequest = cancellation;
        long requestGeneration = ++generation;
        String environmentId = PiRemoteEnvironment.current().id;
        network.execute(() -> {
            try {
                JSONObject result = PiRemoteApi.request("GET",
                    "/v1/files?path=" + Uri.encode(requestedPath), null, cancellation);
                JSONObject directory = result.getJSONObject("directory");
                List<Entry> loaded = new ArrayList<>();
                JSONArray values = directory.getJSONArray("entries");
                for (int index = 0; index < values.length(); index++)
                    loaded.add(new Entry(values.getJSONObject(index)));
                main.post(() -> applyDirectory(requestGeneration, environmentId,
                    directory.optString("path", requestedPath), loaded));
            } catch (PiRemoteApi.Cancelled ignored) {
            } catch (Exception failure) {
                main.post(() -> showFailure(requestGeneration, environmentId, failure));
            }
        });
    }

    private void applyDirectory(long requestGeneration, String environmentId, String path, List<Entry> loaded) {
        if (requestGeneration != generation || !environmentId.equals(PiRemoteEnvironment.current().id)) return;
        activeRequest = null;
        currentPath = path;
        getContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit()
            .putString(PiRemoteEnvironment.scoped(PATH_KEY), path).apply();
        entries.clear();
        entries.addAll(loaded);
        adapter.notifyDataSetChanged();
        renderBreadcrumbs();
        progress.setVisibility(GONE);
        if (entries.isEmpty()) showMessage("Empty folder", false);
        else {
            messageBox.setVisibility(GONE);
            list.setVisibility(VISIBLE);
        }
    }

    private void showFailure(long requestGeneration, String environmentId, Exception failure) {
        if (requestGeneration != generation || !environmentId.equals(PiRemoteEnvironment.current().id)) return;
        activeRequest = null;
        String detail = failure.getMessage();
        showMessage(detail == null || detail.isBlank() ? "Could not read folder" : detail, true);
    }

    private void showLoading() {
        list.setVisibility(GONE);
        messageBox.setVisibility(GONE);
        progress.setVisibility(VISIBLE);
    }

    private void showMessage(String value, boolean failed) {
        list.setVisibility(GONE);
        progress.setVisibility(GONE);
        message.setText(value);
        retry.setVisibility(failed ? VISIBLE : GONE);
        root.setVisibility(!"/".equals(currentPath) ? VISIBLE : GONE);
        messageBox.setVisibility(VISIBLE);
    }

    private void activate(Entry entry) {
        if (entry.directory()) {
            haptics.play(Haptics.Feel.PICK);
            navigate(entry.path);
        } else if (entry.file()) {
            haptics.play(Haptics.Feel.PICK);
            listener.download(entry.path);
        }
    }

    private void copyPath(String path) {
        ClipboardManager clipboard = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
        clipboard.setPrimaryClip(ClipData.newPlainText("File path", path));
        haptics.play(Haptics.Feel.SELECT);
        Toast.makeText(getContext(), "Copied " + path, Toast.LENGTH_SHORT).show();
    }

    private void renderBreadcrumbs() {
        breadcrumbs.removeAllViews();
        List<FileNavigation.Crumb> crumbs = FileNavigation.crumbs(currentPath);
        for (int index = 0; index < crumbs.size(); index++) {
            FileNavigation.Crumb crumb = crumbs.get(index);
            if (index > 0) {
                TextView separator = label("›", 16, false);
                separator.setTextColor(PiRemoteColors.MUTED);
                separator.setGravity(Gravity.CENTER);
                breadcrumbs.addView(separator, new LayoutParams(dp(18), -1));
            }
            TextView item = label(crumb.label, 14, index == crumbs.size() - 1);
            item.setTextColor(index == crumbs.size() - 1 ? PiRemoteColors.TEXT : PiRemoteColors.MUTED);
            item.setGravity(Gravity.CENTER);
            item.setPadding(dp(8), 0, dp(8), 0);
            item.setSingleLine(true);
            item.setOnClickListener(view -> navigate(crumb.path));
            item.setContentDescription("Open " + crumb.path);
            haptics.arm(item);
            breadcrumbs.addView(item, new LayoutParams(-2, -1));
        }
        up.setEnabled(!"/".equals(currentPath));
        up.setTextColor(up.isEnabled() ? PiRemoteColors.TEXT : PiRemoteColors.MUTED);
        breadcrumbScroll.post(() -> breadcrumbScroll.fullScroll(HorizontalScrollView.FOCUS_RIGHT));
    }

    private Button actionButton(String value, String description) {
        Button button = new Button(getContext());
        button.setText(value);
        button.setAllCaps(false);
        button.setTextSize(14);
        button.setTextColor(PiRemoteColors.TEXT);
        button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        button.setPadding(dp(10), 0, dp(10), 0);
        button.setMinHeight(0);
        button.setMinimumHeight(0);
        button.setMinWidth(0);
        button.setMinimumWidth(0);
        button.setBackground(roundRect(PiRemoteColors.SURFACE_2, dp(10)));
        button.setStateListAnimator(null);
        button.setContentDescription(description);
        haptics.arm(button);
        return button;
    }

    private TextView label(String value, float size, boolean bold) {
        TextView view = new TextView(getContext());
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(PiRemoteColors.TEXT);
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return view;
    }

    private GradientDrawable roundRect(int color, int radius) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(radius);
        return drawable;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private final class EntryAdapter extends BaseAdapter {
        @Override public int getCount() { return entries.size(); }
        @Override public Entry getItem(int position) { return entries.get(position); }
        @Override public long getItemId(int position) { return position; }

        @Override public View getView(int position, View convertView, ViewGroup parent) {
            Row row;
            LinearLayout root;
            if (convertView instanceof LinearLayout) {
                root = (LinearLayout) convertView;
                row = (Row) root.getTag();
            } else {
                root = new LinearLayout(getContext());
                root.setGravity(Gravity.CENTER_VERTICAL);
                root.setPadding(dp(16), 0, dp(12), 0);
                ImageView icon = new ImageView(getContext());
                icon.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
                root.addView(icon, new LayoutParams(dp(28), dp(28)));
                TextView name = label("", 15, false);
                name.setSingleLine(true);
                name.setEllipsize(TextUtils.TruncateAt.MIDDLE);
                LayoutParams nameParams = new LayoutParams(0, -1, 1);
                nameParams.leftMargin = dp(12);
                root.addView(name, nameParams);
                TextView arrow = label("›", 24, false);
                arrow.setTextColor(PiRemoteColors.MUTED);
                arrow.setGravity(Gravity.CENTER);
                root.addView(arrow, new LayoutParams(dp(28), -1));
                row = new Row(icon, name, arrow);
                root.setTag(row);
            }
            Entry entry = entries.get(position);
            row.icon.setImageResource(entry.directory() ? R.drawable.ic_folder : R.drawable.ic_file);
            int ink = entry.directory() ? PiRemoteColors.ACCENT : entry.file() ? PiRemoteColors.TEXT : PiRemoteColors.MUTED;
            row.icon.setColorFilter(ink);
            row.icon.setAlpha(entry.directory() || entry.file() ? 1f : 0.45f);
            row.name.setText(entry.name);
            row.name.setTextColor(ink);
            row.arrow.setVisibility(entry.directory() ? VISIBLE : INVISIBLE);
            root.setAlpha(entry.directory() || entry.file() ? 1f : 0.55f);
            root.setContentDescription(entry.name + (entry.directory()
                ? ", folder" : entry.file() ? ", file. Tap to download, hold to copy path" : ", special file"));
            haptics.arm(root);
            return root;
        }
    }
}
