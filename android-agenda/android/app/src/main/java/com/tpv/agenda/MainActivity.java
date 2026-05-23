package com.tpv.agenda;

import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        registerPlugin(WhatsAppPlugin.class);
        WebView wv = getBridge().getWebView();
        if (wv != null) {
            wv.addJavascriptInterface(new WebAppInterface(this), "AndroidBridge");
        }
    }
}
