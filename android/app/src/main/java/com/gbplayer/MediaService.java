package com.gbplayer;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.IBinder;

/**
 * Foreground service that shows the media notification (control center / lock screen) for the
 * MediaSession owned by MainActivity, and keeps the process alive while a video plays in the background.
 */
public class MediaService extends Service {
    private static final String CHANNEL = "playback";
    private static final int ID = 1;
    static volatile MediaSession session;

    static void refresh(Context c) {
        Intent i = new Intent(c, MediaService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
        } catch (RuntimeException ignored) { }
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, MediaService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        MediaSession s = session;
        if (s == null) { stopSelf(); return START_NOT_STICKY; }
        Notification n = build(s);
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(ID, n);
        }
        PlaybackState ps = s.getController().getPlaybackState();
        if (ps == null || ps.getState() != PlaybackState.STATE_PLAYING) {
            stopForeground(false); // keep the notification, but let it be swiped away when paused
        }
        return START_NOT_STICKY;
    }

    private Notification build(MediaSession s) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Playback", NotificationManager.IMPORTANCE_LOW));
        }
        MediaMetadata md = s.getController().getMetadata();
        PlaybackState ps = s.getController().getPlaybackState();
        boolean playing = ps != null && ps.getState() == PlaybackState.STATE_PLAYING;
        String title = md != null ? md.getString(MediaMetadata.METADATA_KEY_TITLE) : null;

        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        b.setSmallIcon(playing ? android.R.drawable.ic_media_play : android.R.drawable.ic_media_pause)
                .setContentTitle(title != null && !title.isEmpty() ? title : "Bomba Gigante")
                .setContentIntent(content)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setOnlyAlertOnce(true)
                .setOngoing(playing)
                .setStyle(new Notification.MediaStyle().setMediaSession(s.getSessionToken()));
        return b.build();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
