package com.example.ytmusic;

import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

/** Receives playback snapshots from assets/ytbridge.js (exposed to the page as YTMBridge). */
public class WebBridge {

    private final Handler main = new Handler(Looper.getMainLooper());

    @JavascriptInterface
    public void onState(String json) {
        try {
            JSONObject o = new JSONObject(json);
            final String title = o.optString("title", "");
            final String artist = o.optString("artist", "");
            final String album = o.optString("album", "");
            final String artwork = upscale(o.optString("artwork", ""));
            final boolean playing = o.optBoolean("playing", false);
            final long duration = o.optLong("duration", 0);
            final long position = o.optLong("position", 0);
            main.post(() -> WebPlayer.getInstance()
                    .updateFromWeb(title, artist, album, artwork, playing, duration, position));
        } catch (Exception ignored) {
        }
    }

    /** Ask Google's image servers for a sharp 512px cover instead of the tiny thumbnail. */
    private static String upscale(String url) {
        if (url.startsWith("//")) url = "https:" + url;
        if (url.contains("googleusercontent.com") || url.contains("ggpht.com")) {
            return url.replaceAll("=w\\d+-h\\d+", "=w512-h512");
        }
        return url;
    }
}
