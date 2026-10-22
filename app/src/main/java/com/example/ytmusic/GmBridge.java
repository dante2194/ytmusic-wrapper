package com.example.ytmusic;

import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native HTTP for the GM_xmlhttpRequest shim (assets/ytgm_shim.js).
 * Only SponsorBlock, translate, lyrics and YouTube stats hosts are reachable.
 */
public class GmBridge {

    private static final ExecutorService POOL = Executors.newFixedThreadPool(3);

    private final WebView webView;

    public GmBridge(WebView webView) {
        this.webView = webView;
    }

    private static final java.util.Set<String> HOSTS = new java.util.HashSet<>(java.util.Arrays.asList(
            "sponsor.ajay.app", "bsbsb.top",
            "translate.googleapis.com", "ytm.nwvbug.com", "www.youtube.com"));

    private static boolean allowed(URL u) {
        return "https".equals(u.getProtocol()) && HOSTS.contains(u.getHost());
    }

    @JavascriptInterface
    public void request(final String id, final String method, final String url,
                        final String headersJson, final String body) {
        POOL.execute(() -> {
            int status = 0;
            String text = "";
            String err = "";
            try {
                URL u = new URL(url);
                if (!allowed(u)) throw new java.io.IOException("host not allowed");

                HttpURLConnection c = (HttpURLConnection) u.openConnection();
                c.setRequestMethod(method == null || method.isEmpty() ? "GET" : method);
                c.setConnectTimeout(10000);
                c.setReadTimeout(15000);

                if (headersJson != null && !headersJson.isEmpty()) {
                    JSONObject h = new JSONObject(headersJson);
                    Iterator<String> it = h.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        c.setRequestProperty(k, h.optString(k));
                    }
                }
                if (body != null && !body.isEmpty()) {
                    c.setDoOutput(true);
                    try (OutputStream os = c.getOutputStream()) {
                        os.write(body.getBytes("UTF-8"));
                    }
                }

                status = c.getResponseCode();
                InputStream is = status >= 400 ? c.getErrorStream() : c.getInputStream();
                if (is != null) {
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = is.read(buf)) != -1) out.write(buf, 0, n);
                    is.close();
                    text = out.toString("UTF-8");
                }
                c.disconnect();
            } catch (Exception e) {
                err = String.valueOf(e);
            }

            final String js = "window.__ytmGmDone&&window.__ytmGmDone("
                    + JSONObject.quote(id) + "," + status + ","
                    + JSONObject.quote(text) + "," + JSONObject.quote(err) + ")";
            try {
                webView.post(() -> webView.evaluateJavascript(js, null));
            } catch (Exception ignored) {
            }
        });
    }
}
