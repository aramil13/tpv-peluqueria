package com.tpv.agenda;

import android.content.Intent;
import android.net.Uri;
import android.webkit.JavascriptInterface;

public class WebAppInterface {
    private MainActivity activity;

    public WebAppInterface(MainActivity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public void openUrl(String url) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        activity.startActivity(intent);
    }
}
