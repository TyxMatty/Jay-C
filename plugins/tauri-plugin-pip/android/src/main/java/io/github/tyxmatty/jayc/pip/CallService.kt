package io.github.tyxmatty.jayc.pip

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

private const val CHANNEL = "jayc-call"
private const val NOTIFICATION_ID = 4711

/**
 * Keeps a call going with Jay-C in the background (Android). Android silences the microphone of an
 * app in the background within seconds unless a foreground service of type `microphone` runs
 * (measured on Android 16: 50 -> 5 packets/s after the PiP closed). This is that service: started
 * when a call begins (the app is in front then, which Android 14+ requires), with a notification
 * ("In a call in #room", Mute/Unmute, Leave; a tap opens the app), stopped when the call ends.
 * Texts come from the page, already translated.
 */
class CallService : Service() {
    data class Texts(
        val title: String,
        val text: String,
        val mute: String,
        val unmute: String,
        val leave: String,
        val channel: String,
    )

    companion object {
        const val ACTION_START = "io.github.tyxmatty.jayc.call.START"
        const val ACTION_UPDATE = "io.github.tyxmatty.jayc.call.UPDATE"
        const val ACTION_STOP = "io.github.tyxmatty.jayc.call.STOP"
        const val ACTION_MUTE = "io.github.tyxmatty.jayc.call.MUTE"
        const val ACTION_LEAVE = "io.github.tyxmatty.jayc.call.LEAVE"

        /** Whether the service is up: the WebView stays running in the background while it is. */
        @Volatile
        var running = false
            private set

        /** Notification buttons, passed to the page by PipPlugin (`callAction`). */
        @Volatile
        var onAction: ((String) -> Unit)? = null

        @Volatile
        private var texts: Texts? = null

        @Volatile
        private var muted = false

        fun start(context: Context, texts: Texts, muted: Boolean) {
            this.texts = texts
            this.muted = muted
            val intent = Intent(context, CallService::class.java).setAction(ACTION_START)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
        }

        fun update(context: Context, muted: Boolean) {
            this.muted = muted
            if (running) context.startService(Intent(context, CallService::class.java).setAction(ACTION_UPDATE))
        }

        fun stop(context: Context) {
            if (running) context.startService(Intent(context, CallService::class.java).setAction(ACTION_STOP))
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START, ACTION_UPDATE -> show()
            ACTION_STOP -> {
                running = false
                ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
            ACTION_MUTE -> onAction?.invoke("toggle-mic")
            ACTION_LEAVE -> onAction?.invoke("leave")
        }
        // Not restarted by the system if the process dies: the call died with it.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        running = false
        super.onDestroy()
    }

    private fun show() {
        val t = texts ?: return stopSelf()
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL, t.channel, NotificationManager.IMPORTANCE_LOW))
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val open = packageManager.getLaunchIntentForPackage(packageName)
            ?.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        val action = { name: String, code: Int ->
            PendingIntent.getService(this, code, Intent(this, CallService::class.java).setAction(name), flags)
        }
        val notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.jayc_call_notification)
            .setContentTitle(t.title)
            .setContentText(t.text)
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(open?.let { PendingIntent.getActivity(this, 1, it, flags) })
            .addAction(0, if (muted) t.unmute else t.mute, action(ACTION_MUTE, 2))
            .addAction(0, t.leave, action(ACTION_LEAVE, 3))
            .build()
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
            running = true
        } catch (e: Exception) {
            // Android 14+ refuses a microphone service started from the background, or without the
            // microphone permission: the call goes on, it just goes quiet in the background.
            Log.w("JayC/Pip", "call service not started: $e")
            running = false
            stopSelf()
        }
    }
}
