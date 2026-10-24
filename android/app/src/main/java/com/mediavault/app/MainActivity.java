package com.mediavault.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.text.InputType;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Media Vault (the PocketBase site in pb_public/) in a full-screen browser view, plus what a plain
 * WebView doesn't do on its own: picking several photos/videos to upload, saving downloads to the
 * phone's Downloads folder, full-screen video, and remembering which server to talk to.
 */
public class MainActivity extends Activity {
    private static final int REQ_FILE = 1, REQ_LOCATION = 2;
    // No built-in address: the first launch asks for it (setup's last page shows what to type). Over Tailscale it's
    // https://{pc}.{tailnet}.ts.net:8443 - the plain address (443) serves the hosted sites.
    private static final String DEFAULT_SERVER = "";
    private static final String EXAMPLE_SERVER = "https://my-pc.my-tailnet.ts.net:8443";
    private SharedPreferences prefs;
    private FrameLayout root;
    private WebView web;
    private ValueCallback<Uri[]> fileCb;
    private Intent pickIntent;
    private View fullscreen;
    private WebChromeClient.CustomViewCallback fullscreenCb;
    private AlertDialog errorDialog;
    // The bridge (window.MediaVaultNative) is added to every page and frame, hosted sites included, so its entry points
    // want this key, handed only to Media Vault's own page (onPageFinished): another origin - a site in the app's frame
    // or opened in the app - can't read it. New for every page load.
    private volatile String pageKey;
    private boolean homeLoad; // load() is opening the server address: where it lands is Media Vault (appOrigin())

    @SuppressLint("SetJavaScriptEnabled")
    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        prefs = getSharedPreferences("vault", MODE_PRIVATE);
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true); // chrome://inspect on test builds only
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#111318"));
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#111318"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // the sign-in token lives in localStorage
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(s.getUserAgentString() + " MediaVaultApp/" + BuildConfig.VERSION_NAME);
        web.addJavascriptInterface(new Bridge(), "MediaVaultNative");

        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl(), home = Uri.parse(server());
                if (u.getHost() != null && u.getHost().equals(home.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }
            @Override public void onPageFinished(WebView v, String url) {
                Uri u = Uri.parse(url);
                if (origin(u).isEmpty()) return; // (the blank page behind "Can't reach Media Vault")
                if (homeLoad) {
                    homeLoad = false;
                    // The sites' address sends the app on to Media Vault's (:8443); remember where it really is.
                    if (u.getHost().equalsIgnoreCase(String.valueOf(Uri.parse(server()).getHost()))) prefs.edit().putString("appOrigin", origin(u)).apply();
                }
                if (!origin(u).equals(appOrigin())) { pageKey = null; return; }
                byte[] k = new byte[24];
                new SecureRandom().nextBytes(k);
                pageKey = Base64.encodeToString(k, Base64.NO_WRAP | Base64.URL_SAFE);
                v.evaluateJavascript("window.__mvNativeKey='" + pageKey + "';window.dispatchEvent(new Event('mvnative'))", null);
            }
            @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) cantConnect(String.valueOf(e.getDescription()));
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                Intent i = p.createIntent();
                i.setType("*/*"); // the page's accept list mixes MIME types and extensions; let it filter
                i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"image/*", "video/*"});
                if (p.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                pickIntent = Intent.createChooser(i, "Add to Media Vault");
                // Ask once for media location access first (see original()); the picker opens whatever the answer.
                String[] need = locationPermissions();
                if (need.length > 0 && !prefs.getBoolean("askedLocation", false)) {
                    prefs.edit().putBoolean("askedLocation", true).apply();
                    requestPermissions(need, REQ_LOCATION);
                } else {
                    openPicker();
                }
                return true;
            }
            @Override public void onShowCustomView(View view, CustomViewCallback cb) { // full-screen video
                if (fullscreen != null) { cb.onCustomViewHidden(); return; }
                fullscreen = view; fullscreenCb = cb;
                root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                web.setVisibility(View.GONE);
                WindowInsetsController c = Build.VERSION.SDK_INT >= 30 ? getWindow().getInsetsController() : null;
                if (c != null) {
                    c.hide(WindowInsets.Type.systemBars());
                    c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                }
            }
            @Override public void onHideCustomView() {
                if (fullscreen == null) return;
                root.removeView(fullscreen);
                fullscreen = null;
                web.setVisibility(View.VISIBLE);
                WindowInsetsController c = Build.VERSION.SDK_INT >= 30 ? getWindow().getInsetsController() : null;
                if (c != null) c.show(WindowInsets.Type.systemBars());
                if (fullscreenCb != null) { fullscreenCb.onCustomViewHidden(); fullscreenCb = null; }
            }
        });

        // "Download" in the app links to the file with ?download=1&token=…, so Android can fetch it itself.
        web.setDownloadListener((url, ua, disposition, mime, length) -> {
            try {
                String name = URLUtil.guessFileName(url, disposition, mime);
                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url))
                    .setTitle(name)
                    .setMimeType(mime)
                    .addRequestHeader("User-Agent", ua)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "Media Vault/" + name);
                ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(req);
                Toast.makeText(this, "Downloading " + name, Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                Toast.makeText(this, "Download failed: " + e.getMessage(), Toast.LENGTH_LONG).show();
            }
        });

        // Android 15+ draws apps edge-to-edge: keep the page between the status bar and the
        // navigation bar (and above the keyboard) instead of underneath them.
        if (Build.VERSION.SDK_INT >= 35) { // older versions already keep the page clear of the bars
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                v.setPadding(i.left, i.top, i.right, i.bottom);
                return WindowInsets.CONSUMED;
            });
        }

        root.addView(web);
        setContentView(root);
        if (b != null) web.restoreState(b);
        else if (!prefs.contains("server")) askServer(false);
        else load();
    }

    private String server() {
        String s = prefs.getString("server", DEFAULT_SERVER).trim();
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }

    private void setServer(String s) {
        s = s.trim();
        if (!s.isEmpty() && !s.contains("://")) s = "http://" + s;
        prefs.edit().putString("server", s.isEmpty() ? DEFAULT_SERVER : s).remove("appOrigin").apply();
    }

    private void load() { homeLoad = true; web.loadUrl(server() + "/"); }

    /** scheme://host:port, or "" for anything that isn't http(s). */
    private static String origin(Uri u) {
        String scheme = u == null ? null : u.getScheme(), host = u == null ? null : u.getHost();
        if (host == null || !("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))) return "";
        int port = u.getPort() != -1 ? u.getPort() : "https".equalsIgnoreCase(scheme) ? 443 : 80;
        return scheme.toLowerCase() + "://" + host.toLowerCase() + ":" + port;
    }

    /** Media Vault's own origin: where opening the server address landed, else the address itself. */
    private String appOrigin() {
        String o = prefs.getString("appOrigin", "");
        return o.isEmpty() ? origin(Uri.parse(server())) : o;
    }

    private boolean keyOk(String key) {
        String k = pageKey;
        return k != null && key != null && MessageDigest.isEqual(k.getBytes(StandardCharsets.UTF_8), key.getBytes(StandardCharsets.UTF_8));
    }

    private void askServer(boolean cancelable) {
        EditText e = new EditText(this);
        e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        e.setText(server());
        e.setHint(EXAMPLE_SERVER);
        AlertDialog.Builder d = new AlertDialog.Builder(this)
            .setTitle("Media Vault server address")
            .setMessage("The address shown on the last page of Media Vault setup on your PC, e.g. " + EXAMPLE_SERVER + " (over Tailscale) or http://192.168.1.20:8091 (at home).")
            .setView(e)
            .setCancelable(cancelable)
            .setPositiveButton("Connect", (dlg, w) -> {
                if (e.getText().toString().trim().isEmpty()) { askServer(cancelable); return; } // nothing typed: ask again
                setServer(e.getText().toString());
                load();
            });
        if (cancelable) d.setNegativeButton("Cancel", null);
        d.show();
    }

    private void cantConnect(String why) {
        if (errorDialog != null && errorDialog.isShowing()) return;
        web.loadData("<html><body style='background:#111318'></body></html>", "text/html", "utf-8");
        errorDialog = new AlertDialog.Builder(this)
            .setTitle("Can't reach Media Vault")
            .setMessage("Couldn't open " + server() + " (" + why + ").\n\nCheck that Tailscale is on for this phone and that start.bat is running on the PC.")
            .setCancelable(false)
            .setPositiveButton("Retry", (d, w) -> load())
            .setNeutralButton("Change address", (d, w) -> askServer(false))
            .show();
    }

    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }
    @Override protected void onResume() { super.onResume(); web.onResume(); }
    @Override protected void onPause() { web.onPause(); super.onPause(); }

    @Override public void onBackPressed() {
        if (fullscreen != null) { web.getWebChromeClient().onHideCustomView(); return; }
        // Let the page close whatever is open first (viewer, dialog, menu, selection) — see vaultBack in app.js.
        web.evaluateJavascript("window.vaultBack ? window.vaultBack() : false", handled -> {
            if ("true".equals(handled)) return;
            if (web.canGoBack()) web.goBack(); else moveTaskToBack(true);
        });
    }

    @Override protected void onActivityResult(int req, int result, Intent data) {
        super.onActivityResult(req, result, data);
        if (req != REQ_FILE || fileCb == null) return;
        Uri[] picked = null;
        if (result == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) {
                picked = new Uri[clip.getItemCount()];
                for (int i = 0; i < picked.length; i++) picked[i] = original(clip.getItemAt(i).getUri());
            } else if (data.getData() != null) {
                picked = new Uri[]{original(data.getData())};
            }
        }
        fileCb.onReceiveValue(picked);
        fileCb = null;
    }

    @Override public void onRequestPermissionsResult(int req, String[] perms, int[] results) {
        if (req == REQ_LOCATION && fileCb != null) openPicker();
    }

    private void openPicker() {
        try { startActivityForResult(pickIntent, REQ_FILE); }
        catch (Exception e) { if (fileCb != null) fileCb.onReceiveValue(null); fileCb = null; }
    }

    /** The permissions still missing for reading photo locations (none before Android 10, which never hid them). */
    private String[] locationPermissions() {
        if (Build.VERSION.SDK_INT < 29) return new String[0];
        java.util.List<String> need = new java.util.ArrayList<>();
        String[] all = Build.VERSION.SDK_INT >= 33
            ? new String[]{Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO, Manifest.permission.ACCESS_MEDIA_LOCATION}
            : new String[]{Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.ACCESS_MEDIA_LOCATION};
        for (String p : all) if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) need.add(p);
        return need.toArray(new String[0]);
    }

    /**
     * Android 10+ blanks the GPS position inside photos and videos an app reads, unless the app holds
     * ACCESS_MEDIA_LOCATION and asks for the original file. Point WebView at the original when that works;
     * otherwise (no permission, not a gallery item, a picker that won't allow it) keep the picked file as is.
     */
    private Uri original(Uri u) {
        if (Build.VERSION.SDK_INT < 29 || checkSelfPermission(Manifest.permission.ACCESS_MEDIA_LOCATION) != PackageManager.PERMISSION_GRANTED) return u;
        try {
            Uri m = DocumentsContract.isDocumentUri(this, u) ? MediaStore.getMediaUri(this, u) : u;
            if (m == null || !MediaStore.AUTHORITY.equals(m.getAuthority())) return u;
            Uri o = MediaStore.setRequireOriginal(m);
            try (ParcelFileDescriptor fd = getContentResolver().openFileDescriptor(o, "r")) { return fd != null ? o : u; }
        } catch (Exception e) {
            return u;
        }
    }

    /** window.MediaVaultNative — used by the locked folder in app.js. The first argument is pageKey (see above). */
    final class Bridge {
        private final Map<String, OutputStream> outs = new HashMap<>();
        private final Map<String, Uri> uris = new HashMap<>();

        /** 2 = wants the key (app.js only sends it when this is there, so older app versions keep working). */
        @JavascriptInterface public int version() { return 2; }

        /** While the locked folder is open: no screenshots, and a blank card in the app switcher. */
        @JavascriptInterface public void secure(String key, boolean on) {
            if (!keyOk(key)) return;
            runOnUiThread(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
            });
        }

        // Decrypted files only exist as blob: URLs, which DownloadManager can't fetch, so the page streams
        // them here in base64 pieces: saveBegin → saveChunk… → saveEnd. Saved to Downloads/Media Vault/. (The chunks
        // need the random id saveBegin hands out, so only the page that started a save can add to it.)
        @JavascriptInterface public synchronized String saveBegin(String key, String name, String mime) {
            if (Build.VERSION.SDK_INT < 29 || !keyOk(key)) return ""; // page falls back to a normal link
            try {
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, name.replaceAll("[\\\\/:*?\"<>|]", "_"));
                v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Media Vault");
                v.put(MediaStore.MediaColumns.IS_PENDING, 1);
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) return "";
                String id = UUID.randomUUID().toString();
                uris.put(id, uri);
                outs.put(id, getContentResolver().openOutputStream(uri));
                return id;
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface public synchronized boolean saveChunk(String id, String b64) {
            OutputStream o = outs.get(id);
            if (o == null) return false;
            try {
                o.write(Base64.decode(b64, Base64.DEFAULT));
                return true;
            } catch (Exception e) {
                discard(id);
                return false;
            }
        }

        @JavascriptInterface public synchronized boolean saveEnd(String id) {
            OutputStream o = outs.remove(id);
            Uri uri = uris.remove(id);
            if (o == null || uri == null) return false;
            try {
                o.close();
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.IS_PENDING, 0);
                getContentResolver().update(uri, v, null, null);
                return true;
            } catch (Exception e) {
                getContentResolver().delete(uri, null, null);
                return false;
            }
        }

        private void discard(String id) {
            OutputStream o = outs.remove(id);
            Uri uri = uris.remove(id);
            try { if (o != null) o.close(); } catch (Exception ignored) { }
            if (uri != null) getContentResolver().delete(uri, null, null);
        }
    }
}
