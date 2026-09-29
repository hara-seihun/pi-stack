package works.kenan.piremote.kenan;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import androidx.core.app.NotificationCompat;

public final class WriteLearningNotice extends BroadcastReceiver {
    private static final String CHANNEL = "write-dictionary";
    private static final int ID = 225;

    static void show(Context context, RemoteSession.Identity identity, WriteConnection.Learned learned) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Write dictionary", NotificationManager.IMPORTANCE_DEFAULT));
        Intent undo = new Intent(context, WriteLearningNotice.class)
            .putExtra("user", identity.user).putExtra("undoId", learned.undoId());
        PendingIntent action = PendingIntent.getBroadcast(context, learned.undoId().hashCode(), undo,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        manager.notify(ID, new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification).setContentTitle("Pi Stack Write learned ‘" + learned.word() + "’")
            .setAutoCancel(true).addAction(0, "Undo", action).build());
    }

    @Override public void onReceive(Context context, Intent intent) {
        RemoteSession.Identity identity = NotificationIdentity.get(context).current();
        if (identity == null || !identity.user.equals(intent.getStringExtra("user"))) return;
        String undoId = intent.getStringExtra("undoId");
        if (undoId == null || undoId.isBlank()) return;
        PendingResult pending = goAsync();
        WriteConnection.undo(context, identity, undoId, result -> {
            if (result != null) context.getSystemService(NotificationManager.class).cancel(ID);
            pending.finish();
        });
    }
}
