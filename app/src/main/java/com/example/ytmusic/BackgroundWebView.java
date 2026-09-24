package com.example.ytmusic;

import android.content.Context;
import android.util.AttributeSet;
import android.view.View;
import android.webkit.WebView;

/**
 * WebView subclass that keeps the media pipeline alive when the
 * app is backgrounded or the screen turns off.
 */
public class BackgroundWebView extends WebView {

    public BackgroundWebView(Context context) {
        super(context);
    }

    public BackgroundWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    public BackgroundWebView(Context context, AttributeSet attrs, int defStyleAttr) {
        super(context, attrs, defStyleAttr);
    }

    @Override
    protected void onWindowVisibilityChanged(int visibility) {
        // Always tell the renderer we are VISIBLE so audio never pauses.
        super.onWindowVisibilityChanged(View.VISIBLE);
    }
}
