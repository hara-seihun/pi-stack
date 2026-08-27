package works.kenan.piremote.kenan.dev;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KenanRemotePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
