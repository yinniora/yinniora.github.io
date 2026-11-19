package io.github.yinniora.yugopi;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.ContextMenu;
import android.view.MenuItem;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/**
 * YuGo Pi for Android: a WebView around the published encrypted remote client.
 * Pairing keys stay in the web client's storage inside this app, exactly as in
 * a browser. The app holds no host credentials of its own.
 */
public class MainActivity extends Activity {
    private static final String CLIENT_URL = "https://yinniora.github.io/";
    private static final String CLIENT_HOST = "yinniora.github.io";
    private static final int REQUEST_CAMERA = 1;
    private static final int REQUEST_FILES = 2;

    private WebView web;
    private PermissionRequest pendingPermission;
    private ValueCallback<Uri[]> pendingFiles;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        web.setBackgroundColor(Color.TRANSPARENT);
        setContentView(web);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptCookie(true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (isClient(uri)) return false;
                openExternal(uri);
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showOffline();
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> handlePermission(request));
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFiles != null) pendingFiles.onReceiveValue(null);
                pendingFiles = callback;
                try {
                    Intent intent = params.createIntent();
                    if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    }
                    startActivityForResult(intent, REQUEST_FILES);
                    return true;
                } catch (ActivityNotFoundException e) {
                    pendingFiles = null;
                    return false;
                }
            }
        });

        // Long-press a link: open in the browser, copy or share it.
        registerForContextMenu(web);

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl(startUrl(getIntent()));
        }
    }

    private static boolean isClient(Uri uri) {
        return uri != null && "https".equals(uri.getScheme()) && CLIENT_HOST.equals(uri.getHost());
    }

    private static String startUrl(Intent intent) {
        Uri data = intent != null ? intent.getData() : null;
        return isClient(data) ? data.toString() : CLIENT_URL;
    }

    private void openExternal(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException ignored) {
            // nothing can handle it
        }
    }

    @Override
    public void onCreateContextMenu(ContextMenu menu, View view, ContextMenu.ContextMenuInfo info) {
        super.onCreateContextMenu(menu, view, info);
        WebView.HitTestResult hit = web.getHitTestResult();
        int type = hit.getType();
        if (type != WebView.HitTestResult.SRC_ANCHOR_TYPE
                && type != WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE) return;
        String link = hit.getExtra();
        if (link == null || !(link.startsWith("https://") || link.startsWith("http://"))) return;
        // For image links getExtra() is the image; ask WebView for the href.
        if (type == WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE) {
            android.os.Message message = new android.os.Handler(getMainLooper()).obtainMessage();
            web.requestFocusNodeHref(message);
            String href = message.getData().getString("url");
            if (href != null) link = href;
        }
        final String url = link;
        menu.setHeaderTitle(url);
        menu.add(R.string.link_open).setOnMenuItemClickListener((MenuItem item) -> {
            openExternal(Uri.parse(url));
            return true;
        });
        menu.add(R.string.link_copy).setOnMenuItemClickListener((MenuItem item) -> {
            ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            clipboard.setPrimaryClip(ClipData.newPlainText("link", url));
            Toast.makeText(this, R.string.link_copied, Toast.LENGTH_SHORT).show();
            return true;
        });
        menu.add(R.string.link_share).setOnMenuItemClickListener((MenuItem item) -> {
            Intent share = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, url);
            startActivity(Intent.createChooser(share, null));
            return true;
        });
    }

    private void showOffline() {
        String html = "<html><head><meta name=viewport content='width=device-width,initial-scale=1'>"
                + "<style>:root{color-scheme:light dark}body{font-family:sans-serif;display:grid;place-items:center;"
                + "height:100vh;margin:0;text-align:center}button{font:inherit;padding:8px 20px;margin-top:16px}</style></head>"
                + "<body><div><p>" + getString(R.string.offline) + "</p>"
                + "<button onclick=\"location.replace('" + CLIENT_URL + "')\">" + getString(R.string.retry)
                + "</button></div></body></html>";
        web.loadDataWithBaseURL(CLIENT_URL, html, "text/html", "utf-8", CLIENT_URL);
    }

    private void handlePermission(PermissionRequest request) {
        boolean wantsCamera = false;
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) wantsCamera = true;
        }
        if (!wantsCamera || !isClient(request.getOrigin())) {
            request.deny();
            return;
        }
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[] {PermissionRequest.RESOURCE_VIDEO_CAPTURE});
            return;
        }
        if (pendingPermission != null) pendingPermission.deny();
        pendingPermission = request;
        requestPermissions(new String[] {Manifest.permission.CAMERA}, REQUEST_CAMERA);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != REQUEST_CAMERA || pendingPermission == null) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
            pendingPermission.grant(new String[] {PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        } else {
            pendingPermission.deny();
            Toast.makeText(this, R.string.camera_denied, Toast.LENGTH_LONG).show();
        }
        pendingPermission = null;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_FILES || pendingFiles == null) return;
        pendingFiles.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
        pendingFiles = null;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (isClient(intent.getData())) web.loadUrl(intent.getData().toString());
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) {
            web.goBack();
        } else {
            moveTaskToBack(true);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onPause() {
        web.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.setVisibility(View.GONE);
            web.destroy();
        }
        super.onDestroy();
    }
}
