package io.github.tyxmatty.jayc

import android.os.Bundle
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import io.github.tyxmatty.jayc.pip.PipPlugin

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Back with nothing left to close: during a call, PiP (as Home does); otherwise Jay-C goes to
    // the background instead of finishing the activity, which ended the process (measured on
    // Android 16) and with it the app's state. Callbacks run newest first, so Tauri's AppPlugin
    // (added later, with the WebView) still gets Back first and walks the page's history (drawers,
    // fullscreen); it only passes Back on here when the page can't go back.
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        if (!PipPlugin.enterForBack()) moveTaskToBack(true)
      }
    })
  }
}
