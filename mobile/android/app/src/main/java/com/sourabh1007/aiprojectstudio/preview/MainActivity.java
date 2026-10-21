package com.sourabh1007.aiprojectstudio.preview;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

public final class MainActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable connectionTimeout = this::showFailure;
    private LinearLayout root;
    private FrameLayout content;
    private TextView status;
    private WebView webView;
    private String origin;
    private boolean failed;
    private boolean loading;

    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        WebView.setWebContentsDebuggingEnabled(false);
        showConnection();
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(0, this::navigateBack);
        }
    }

    private void createRoot() {
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(244, 247, 250));
        setContentView(root);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets bars = insets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
                return WindowInsets.CONSUMED;
            });
            root.requestApplyInsets();
        } else {
            root.setFitsSystemWindows(true);
        }
    }

    private void showConnection() {
        destroyWebView();
        origin = null;
        createRoot();
        ScrollView scroll = new ScrollView(this);
        LinearLayout panel = panel();
        scroll.addView(panel);
        root.addView(scroll);
        label(panel, R.string.heading, 30);
        label(panel, R.string.preview_notice, 14);
        label(panel, R.string.connection_help, 17);
        label(panel, R.string.permissions_warning, 17);
        label(panel, R.string.host_label, 16);
        EditText input = new EditText(this);
        input.setHint(R.string.host_hint);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI
                | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        input.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        input.setSaveEnabled(false);
        input.setText(getPreferences(MODE_PRIVATE).getString("host_origin", ""));
        panel.addView(input);
        button(panel, R.string.connect, () -> {
            try {
                String host = HostOrigin.parse(input.getText().toString());
                getPreferences(MODE_PRIVATE).edit().putString("host_origin", host).apply();
                ((InputMethodManager) getSystemService(INPUT_METHOD_SERVICE))
                        .hideSoftInputFromWindow(input.getWindowToken(), 0);
                connect(host);
            } catch (HostOrigin.InvalidOrigin exception) {
                input.setError(getString(originError(exception.error)));
            }
        });
        label(panel, R.string.session_help, 15);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void connect(String host) {
        destroyWebView();
        origin = host;
        failed = false;
        createRoot();
        LinearLayout toolbar = panel();
        status = label(toolbar, R.string.connecting, 14);
        button(toolbar, R.string.change_host, this::showConnection);
        root.addView(toolbar);
        content = new FrameLayout(this);
        root.addView(content, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        webView = new WebView(this);
        webView.setSaveEnabled(false);
        webView.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setGeolocationEnabled(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSafeBrowsingEnabled(true);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (HostOrigin.contains(origin, request.getUrl().toString())) return false;
                if (request.isForMainFrame() && request.hasGesture()
                        && HostOrigin.isBrowserLink(request.getUrl().toString())) {
                    openBrowser(request.getUrl());
                } else if (request.isForMainFrame()) {
                    Toast.makeText(MainActivity.this, R.string.blocked_link, Toast.LENGTH_LONG).show();
                }
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                if (!HostOrigin.contains(origin, url)) {
                    view.stopLoading();
                    showFailure();
                    return;
                }
                loading = true;
                status.setText(R.string.connecting);
                handler.removeCallbacks(connectionTimeout);
                handler.postDelayed(connectionTimeout, 30_000);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (failed || !HostOrigin.contains(origin, url)) return;
                loading = false;
                handler.removeCallbacks(connectionTimeout);
                status.setText(R.string.connected);
                CookieManager.getInstance().flush();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showFailure();
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request,
                    WebResourceResponse response) {
                if (request.isForMainFrame() && response.getStatusCode() >= 400) showFailure();
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler sslHandler, SslError error) {
                sslHandler.cancel();
                showFailure();
            }

            @Override
            public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                ((ViewGroup) view.getParent()).removeView(view);
                view.destroy();
                webView = null;
                showFailure();
                return true;
            }
        });
        content.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        webView.loadUrl(origin + "/mobile");
    }

    private void showFailure() {
        if (origin == null || failed) return;
        failed = true;
        loading = false;
        handler.removeCallbacks(connectionTimeout);
        if (webView != null) {
            webView.stopLoading();
            webView.setVisibility(View.GONE);
        }
        status.setText(R.string.preview_notice);
        LinearLayout panel = panel();
        label(panel, R.string.connection_failed, 18);
        button(panel, R.string.retry, () -> connect(origin));
        button(panel, R.string.change_host, this::showConnection);
        content.addView(panel);
    }

    private void openBrowser(Uri uri) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            startActivity(Intent.createChooser(intent, getString(R.string.external_link)));
        } catch (ActivityNotFoundException exception) {
            Toast.makeText(this, R.string.external_unavailable, Toast.LENGTH_LONG).show();
        }
    }

    private void navigateBack() {
        if (webView != null && !failed && webView.canGoBack()) {
            webView.goBack();
        } else if (origin != null) {
            showConnection();
        } else {
            finish();
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        navigateBack();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
            if (loading) {
                handler.removeCallbacks(connectionTimeout);
                handler.postDelayed(connectionTimeout, 30_000);
            }
        }
    }

    @Override
    protected void onPause() {
        if (webView != null) {
            webView.onPause();
            CookieManager.getInstance().flush();
        }
        handler.removeCallbacks(connectionTimeout);
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        destroyWebView();
        super.onDestroy();
    }

    private void destroyWebView() {
        handler.removeCallbacks(connectionTimeout);
        loading = false;
        if (webView != null) {
            webView.stopLoading();
            webView.setWebViewClient(new WebViewClient());
            ((ViewGroup) webView.getParent()).removeView(webView);
            webView.destroy();
            webView = null;
        }
    }

    private LinearLayout panel() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        int padding = Math.round(20 * getResources().getDisplayMetrics().density);
        panel.setPadding(padding, padding, padding, padding);
        return panel;
    }

    private TextView label(LinearLayout panel, int text, int size) {
        TextView label = new TextView(this);
        label.setText(text);
        label.setTextSize(size);
        label.setTextColor(Color.rgb(20, 37, 61));
        label.setPadding(0, 0, 0, 16);
        panel.addView(label);
        return label;
    }

    private void button(LinearLayout panel, int text, Runnable action) {
        Button button = new Button(this);
        button.setText(text);
        button.setOnClickListener(view -> action.run());
        panel.addView(button);
    }

    private int originError(HostOrigin.Error error) {
        switch (error) {
            case REQUIRED: return R.string.host_required;
            case HTTPS: return R.string.host_https;
            case CREDENTIALS: return R.string.host_credentials;
            case ORIGIN_ONLY: return R.string.host_origin_only;
            case PORT: return R.string.host_port;
            default: return R.string.host_invalid;
        }
    }
}
