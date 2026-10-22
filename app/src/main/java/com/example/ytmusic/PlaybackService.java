package com.example.ytmusic;

import android.app.PendingIntent;
import android.content.Intent;

import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.DefaultMediaNotificationProvider;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import androidx.media3.session.SessionResult;

/**
 * Media3 background-playback service. It owns the MediaSession; Media3 builds the
 * system media notification (artwork, title, artist, prev / play-pause / next,
 * seek bar) and manages the foreground state automatically.
 */
@OptIn(markerClass = UnstableApi.class)
public class PlaybackService extends MediaSessionService {

    private MediaSession mediaSession;

    @Override
    public void onCreate() {
        super.onCreate();

        PendingIntent openApp = PendingIntent.getActivity(
                this, 0,
                new Intent(this, MainActivity.class)
                        .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        mediaSession = new MediaSession.Builder(this, WebPlayer.getInstance())
                .setId("ytmusic_session")
                .setSessionActivity(openApp)
                .setCallback(new SessionCallback())
                .build();

        DefaultMediaNotificationProvider provider =
                new DefaultMediaNotificationProvider.Builder(this).build();
        provider.setSmallIcon(R.drawable.ic_music_note);
        setMediaNotificationProvider(provider);
    }

    @Nullable
    @Override
    public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return mediaSession;
    }

    @Override
    public void onTaskRemoved(@Nullable Intent rootIntent) {
        // The WebView dies with the task, so there is nothing left to control.
        WebPlayer.getInstance().reset();
        pauseAllPlayersAndStopSelf();
    }

    @Override
    public void onDestroy() {
        if (mediaSession != null) {
            mediaSession.release();
            mediaSession = null;
        }
        super.onDestroy();
    }

    /** Next / previous are performed by the web page, not by a real playlist. */
    private static class SessionCallback implements MediaSession.Callback {
        @Override
        public int onPlayerCommandRequest(MediaSession session,
                                          MediaSession.ControllerInfo controller,
                                          int playerCommand) {
            switch (playerCommand) {
                case Player.COMMAND_SEEK_TO_NEXT:
                case Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM:
                    WebPlayer.getInstance().sendNext();
                    return SessionResult.RESULT_INFO_SKIPPED;
                case Player.COMMAND_SEEK_TO_PREVIOUS:
                case Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM:
                    WebPlayer.getInstance().sendPrevious();
                    return SessionResult.RESULT_INFO_SKIPPED;
                default:
                    return SessionResult.RESULT_SUCCESS;
            }
        }
    }
}
