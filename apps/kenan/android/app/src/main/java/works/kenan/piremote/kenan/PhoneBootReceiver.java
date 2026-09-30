package works.kenan.piremote.kenan;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class PhoneBootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
            || Intent.ACTION_USER_UNLOCKED.equals(action)) PhoneControlService.start(context);
    }
}
