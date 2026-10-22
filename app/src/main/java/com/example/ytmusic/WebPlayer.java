package com.example.ytmusic;

import android.net.Uri;
import android.os.Looper;
import android.os.SystemClock;

import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.Player;
import androidx.media3.common.SimpleBasePlayer;
import androidx.media3.common.util.UnstableApi;

import com.google.common.util.concurrent.ListenableFuture;
import com.google.common.util.concurrent.Futures;

import java.util.Collections;

/**
 * A Media3 {@link Player} that does not play anything itself. It mirrors what the
 * YouTube Music page inside the WebView is playing (fed by {@link WebBridge}) and
 * forwards commands (play, pause, seek, next, previous) back to the page.
 *
 * Because it is a real Player, MediaSession / MediaSessionService can build the
 * standard system media notification, lock-screen controls and seek bar from it.
 */
@OptIn(markerClass = UnstableApi.class)
public final class WebPlayer extends SimpleBasePlayer {

    /** Sends a command to the web page. Always called on the main thread. */
    public interface Commander {
        void send(String command, long arg);
    }

    private static WebPlayer instance;

    public static synchronized WebPlayer getInstance() {
        if (instance == null) instance = new WebPlayer();
        return instance;
    }

    private static final Commands COMMANDS = new Commands.Builder()
            .addAll(
                    Player.COMMAND_PLAY_PAUSE,
                    Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM,
                    Player.COMMAND_SEEK_TO_PREVIOUS,
                    Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
                    Player.COMMAND_SEEK_TO_NEXT,
                    Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
                    Player.COMMAND_GET_CURRENT_MEDIA_ITEM,
                    Player.COMMAND_GET_TIMELINE,
                    Player.COMMAND_GET_METADATA)
            .build();

    @Nullable private Commander commander;

    private boolean hasMedia = false;
    private boolean playing = false;
    private String title = "";
    private String artist = "";
    private String album = "";
    private String artworkUrl = "";
    private long durationMs = C.TIME_UNSET;
    private long positionMs = 0;
    private long positionStamp = 0;
    private String trackKey = "";
    private int trackSerial = 0;

    private WebPlayer() {
        super(Looper.getMainLooper());
    }

    public void setCommander(@Nullable Commander c) {
        commander = c;
    }

    // ------------------------------------------------------------------
    //  Web page -> player
    // ------------------------------------------------------------------

    /** Called on the main thread with a fresh snapshot from the page. */
    public void updateFromWeb(String title, String artist, String album, String artworkUrl,
                              boolean playing, long durationMs, long positionMs) {
        String key = title + "\u0000" + artist + "\u0000" + album;
        if (!key.equals(trackKey)) {
            trackKey = key;
            trackSerial++;
        }
        this.hasMedia = true;
        this.title = title;
        this.artist = artist;
        this.album = album;
        this.artworkUrl = artworkUrl;
        this.playing = playing;
        this.durationMs = durationMs > 0 ? durationMs : C.TIME_UNSET;
        this.positionMs = Math.max(0, positionMs);
        this.positionStamp = SystemClock.elapsedRealtime();
        invalidateState();
    }

    /** Removes the media session notification (nothing is loaded any more). */
    public void reset() {
        hasMedia = false;
        playing = false;
        trackKey = "";
        invalidateState();
    }

    // ------------------------------------------------------------------
    //  Commands that arrive from the notification / lock screen / headset
    // ------------------------------------------------------------------

    public void sendNext() {
        send("next", 0);
    }

    public void sendPrevious() {
        send("prev", 0);
    }

    private void send(String cmd, long arg) {
        Commander c = commander;
        if (c != null) c.send(cmd, arg);
    }

    private long currentPositionMs() {
        long p = positionMs;
        if (playing) p += SystemClock.elapsedRealtime() - positionStamp;
        if (durationMs != C.TIME_UNSET) p = Math.min(p, durationMs);
        return Math.max(0, p);
    }

    // ------------------------------------------------------------------
    //  SimpleBasePlayer
    // ------------------------------------------------------------------

    @Override
    protected State getState() {
        if (!hasMedia) {
            return new State.Builder().setPlaybackState(Player.STATE_IDLE).build();
        }

        MediaMetadata.Builder md = new MediaMetadata.Builder()
                .setTitle(title)
                .setArtist(artist)
                .setIsPlayable(true);
        if (!album.isEmpty()) md.setAlbumTitle(album);
        if (!artworkUrl.isEmpty()) md.setArtworkUri(Uri.parse(artworkUrl));

        String uid = "ytm-" + trackSerial;
        MediaItem item = new MediaItem.Builder()
                .setMediaId(uid)
                .setMediaMetadata(md.build())
                .build();

        MediaItemData data = new MediaItemData.Builder(uid)
                .setMediaItem(item)
                .setDurationUs(durationMs == C.TIME_UNSET ? C.TIME_UNSET : durationMs * 1000)
                .setIsSeekable(durationMs != C.TIME_UNSET)
                .build();

        return new State.Builder()
                .setAvailableCommands(COMMANDS)
                .setPlaylist(Collections.singletonList(data))
                .setCurrentMediaItemIndex(0)
                .setPlaybackState(Player.STATE_READY)
                .setPlayWhenReady(playing, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
                // Live position: the seek bar keeps moving without constant updates.
                .setContentPositionMs(this::currentPositionMs)
                .build();
    }

    @Override
    protected ListenableFuture<?> handleSetPlayWhenReady(boolean playWhenReady) {
        positionMs = currentPositionMs();
        positionStamp = SystemClock.elapsedRealtime();
        playing = playWhenReady;
        send(playWhenReady ? "play" : "pause", 0);
        return Futures.immediateVoidFuture();
    }

    @Override
    protected ListenableFuture<?> handleSeek(int mediaItemIndex, long positionMs, int seekCommand) {
        switch (seekCommand) {
            case Player.COMMAND_SEEK_TO_NEXT:
            case Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM:
                send("next", 0);
                break;
            case Player.COMMAND_SEEK_TO_PREVIOUS:
            case Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM:
                send("prev", 0);
                break;
            default:
                long target = positionMs == C.TIME_UNSET ? 0 : positionMs;
                this.positionMs = target;
                this.positionStamp = SystemClock.elapsedRealtime();
                send("seek", target);
        }
        return Futures.immediateVoidFuture();
    }
}
