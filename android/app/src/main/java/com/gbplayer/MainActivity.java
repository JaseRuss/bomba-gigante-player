package com.gbplayer;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.PictureInPictureParams;
import android.content.pm.PackageManager;
import android.util.Rational;
import android.view.KeyEvent;
import android.content.Intent;
import android.graphics.Color;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Hosts the web app from bundled assets in a WebView. Giant Bomb API calls are made from a hidden
 * WebView that sits on giantbomb.com: it is a real Chromium, so Cloudflare lets it through, and
 * being same-origin it needs no CORS handling.
 */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String API_ORIGIN = "https://giantbomb.com";

    private FrameLayout root;
    private WebView ui;
    private WebView api;
    private boolean apiReady = false;
    private final List<Runnable> queued = new ArrayList<>();
    private volatile boolean playing = false;
    private MediaSession mediaSession;
    private String mediaTitle = "";
    private long mediaPos = 0, mediaDur = 0;
    private View customView;
    private WebChromeClient.CustomViewCallback customCallback;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.parseColor("#1a1c20"));
        getWindow().setNavigationBarColor(Color.parseColor("#0f1012"));
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0f1012"));
        setContentView(root);

        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        api = new WebView(this);
        configure(api);
        String ua = api.getSettings().getUserAgentString().replace("; wv", "").replace("Version/4.0 ", "");
        api.getSettings().setUserAgentString(ua);
        api.addJavascriptInterface(new ApiSink(), "GBApi");
        api.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                if (!apiReady && url != null && url.startsWith(API_ORIGIN)) {
                    apiReady = true;
                    for (Runnable r : queued) r.run();
                    queued.clear();
                }
            }
        });
        FrameLayout.LayoutParams tiny = new FrameLayout.LayoutParams(4, 4);
        root.addView(api, tiny);
        api.setAlpha(0.01f);

        ui = new WebView(this);
        configure(ui);
        ui.addJavascriptInterface(new Bridge(), "GBNative");
        ui.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return serve(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame() || HOST.equals(request.getUrl().getHost())) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
                return true;
            }
        });
        ui.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) { callback.onCustomViewHidden(); return; }
                customView = view;
                customCallback = callback;
                root.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                ui.setVisibility(View.GONE);
                setFullscreenMode(true);
            }

            @Override
            public void onHideCustomView() {
                if (customView == null) return;
                root.removeView(customView);
                customView = null;
                customCallback.onCustomViewHidden();
                ui.setVisibility(View.VISIBLE);
                setFullscreenMode(false);
            }
        });
        root.addView(ui, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(ui, true);
        cm.setAcceptThirdPartyCookies(api, true);

        setupMediaSession();
        if (android.os.Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 1);
        }

        api.loadUrl(API_ORIGIN + "/api/shows?limit=1");
        ui.loadUrl("https://" + HOST + "/index.html");
    }

    private void page(String js) { ui.evaluateJavascript(js, null); }

    /** Registers with the system so S Pen / headset keys and the media notification reach the page. */
    private void setupMediaSession() {
        mediaSession = new MediaSession(this, "BombaGigante");
        mediaSession.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { page("window.__gbMedia&&window.__gbMedia('play')"); }
            @Override public void onPause() { page("window.__gbMedia&&window.__gbMedia('pause')"); }
            @Override public void onSkipToNext() { page("window.__gbMedia&&window.__gbMedia('next')"); }
            @Override public void onSkipToPrevious() { page("window.__gbMedia&&window.__gbMedia('prev')"); }
            @Override public void onSeekTo(long ms) { page("window.__gbSeek&&window.__gbSeek(" + (ms / 1000.0) + ")"); }
        });
        MediaService.session = mediaSession;
        publishMedia(false);
    }

    private void publishMedia(boolean on) {
        if (mediaSession == null) return;
        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE
                | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS | PlaybackState.ACTION_SEEK_TO;
        mediaSession.setPlaybackState(new PlaybackState.Builder()
                .setActions(actions)
                .setState(on ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, mediaPos, on ? 1f : 0f)
                .build());
        mediaSession.setMetadata(new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, mediaTitle)
                .putLong(MediaMetadata.METADATA_KEY_DURATION, mediaDur)
                .build());
        // Active even while paused, so the keys keep coming to this app and the notification stays.
        mediaSession.setActive(true);
        if (!mediaTitle.isEmpty()) MediaService.refresh(this);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configure(WebView w) {
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
    }

    @SuppressWarnings("deprecation")
    private void setFullscreenMode(boolean on) {
        getWindow().getDecorView().setSystemUiVisibility(on
                ? View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                : View.SYSTEM_UI_FLAG_VISIBLE);
    }

    private WebResourceResponse serve(Uri uri) {
        if (!HOST.equals(uri.getHost())) return null;
        String path = uri.getPath();
        if (path == null || path.equals("/")) path = "/index.html";
        try {
            InputStream in = getAssets().open(path.substring(1));
            // no-store: the page must always come from this APK, never from a cached older copy.
            java.util.Map<String, String> headers = new java.util.HashMap<>();
            headers.put("Cache-Control", "no-store");
            return new WebResourceResponse(mime(path), "utf-8", 200, "OK", headers, in);
        } catch (IOException e) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null,
                    new ByteArrayInputStream(new byte[0]));
        }
    }

    private static String mime(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js")) return "application/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".json")) return "application/json";
        if (path.endsWith(".svg")) return "image/svg+xml";
        return "application/octet-stream";
    }

    /** Called from the app page. */
    private class Bridge {
        @JavascriptInterface
        public String version() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "?";
            }
        }

        @JavascriptInterface
        public void setMedia(final String title, final long posMs, final long durMs) {
            mediaTitle = title == null ? "" : title;
            mediaPos = posMs;
            mediaDur = durMs;
        }

        @JavascriptInterface
        public void setPlaying(final boolean on) {
            playing = on;
            runOnUiThread(new Runnable() {
                @Override
                public void run() { publishMedia(on); }
            });
            // Keep the screen awake only while a video is playing.
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (on) getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    else getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }

        @JavascriptInterface
        public void fetch(final String id, final String pathAndQuery, final String key) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Runnable go = new Runnable() {
                        @Override
                        public void run() { callApi(id, pathAndQuery, key); }
                    };
                    if (apiReady) go.run(); else queued.add(go);
                }
            });
        }
    }

    /** Called from the hidden giantbomb.com page with each response. */
    private class ApiSink {
        @JavascriptInterface
        public void done(String id, int status, String body) {
            final String js = "window.__gbDone(" + JSONObject.quote(id) + "," + status + ","
                    + JSONObject.quote(body) + ")";
            runOnUiThread(new Runnable() {
                @Override
                public void run() { ui.evaluateJavascript(js, null); }
            });
        }
    }

    private void callApi(String id, String pathAndQuery, String key) {
        String url = API_ORIGIN + "/api/" + pathAndQuery;
        if (key != null && !key.isEmpty()) {
            url += (url.contains("?") ? "&" : "?") + "api_key=" + Uri.encode(key);
        }
        // Retries while Cloudflare's challenge page is still being solved by this WebView.
        String js = "(async function(){var id=" + JSONObject.quote(id) + ",u=" + JSONObject.quote(url)
                + ",k=" + JSONObject.quote(key == null ? "" : key) + ";"
                + "var h={'Accept':'application/json'};if(k)h['X-API-Key']=k;"
                + "for(var i=0;i<8;i++){var r=await fetch(u,{headers:h,credentials:'include'});var t=await r.text();"
                + "if(r.status==403&&/challenge|Just a moment/i.test(t)&&i<7){"
                + "await new Promise(function(s){setTimeout(s,2000)});continue;}"
                + "GBApi.done(id,r.status,t);return;}})()"
                + ".catch(function(e){GBApi.done(id,0,String(e));});";
        api.evaluateJavascript(js, null);
    }

    /** S Pen button, headset and Bluetooth media keys: hand play/pause to the page. */
    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        String action = null;
        switch (e.getKeyCode()) {
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_HEADSETHOOK: action = "toggle"; break;
            case KeyEvent.KEYCODE_MEDIA_PLAY: action = "play"; break;
            case KeyEvent.KEYCODE_MEDIA_PAUSE: action = "pause"; break;
            case KeyEvent.KEYCODE_MEDIA_NEXT: action = "next"; break;
            default: break;
        }
        if (action == null) return super.dispatchKeyEvent(e);
        if (e.getAction() == KeyEvent.ACTION_DOWN && e.getRepeatCount() == 0) {
            ui.evaluateJavascript("window.__gbMedia&&window.__gbMedia('" + action + "')", null);
        }
        return true;
    }

    /** Leaving the app while a video plays shrinks it to a picture-in-picture window. */
    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (playing && getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
            try {
                enterPictureInPictureMode(new PictureInPictureParams.Builder()
                        .setAspectRatio(new Rational(16, 9)).build());
            } catch (IllegalStateException ignored) { }
        }
    }

    @Override
    public void onPictureInPictureModeChanged(boolean inPip, android.content.res.Configuration cfg) {
        super.onPictureInPictureModeChanged(inPip, cfg);
        ui.evaluateJavascript("document.body.classList.toggle('pip'," + inPip + ")", null);
    }

    @Override
    public void onBackPressed() {
        if (customView != null) {
            ui.getWebChromeClient().onHideCustomView();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        MediaService.stop(this);
        MediaService.session = null;
        if (mediaSession != null) { mediaSession.setActive(false); mediaSession.release(); }
        ui.destroy();
        api.destroy();
        super.onDestroy();
    }
}
