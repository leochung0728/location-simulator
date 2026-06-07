/*
 * MockLocationService.kt — 實體 Android 裝置用伴隨服務（核心參考）
 *
 * 這是 desktop 端 android-adapter.ts 在「實體裝置」路徑下所搭配的元件。
 * 它做三件事：
 *   1. 以 LocalServerSocket 監聽一條 abstract socket（adb forward 會接到這裡）
 *   2. 在 LocationManager 上註冊一個 test provider
 *   3. 讀取每行 "lat,lng"，呼叫 setTestProviderLocation 注入座標
 *
 * 需自行建成 APK，並於「開發者選項 → 選擇模擬位置應用程式」選擇本 App。
 * 用途為定位功能測試。
 *
 * AndroidManifest 需求（摘要）：
 *   <uses-permission android:name="android.permission.ACCESS_MOCK_LOCATION"/>
 *   <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"/>
 *   <uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>
 *   <service android:name=".MockLocationService" android:foregroundServiceType="location"/>
 */
package com.example.mocklocation

import android.app.Service
import android.content.Intent
import android.location.Location
import android.location.LocationManager
import android.location.provider.ProviderProperties
import android.net.LocalServerSocket
import android.os.IBinder
import android.os.SystemClock
import kotlin.concurrent.thread

class MockLocationService : Service() {

    private val socketName = "mocklocation"          // 對應 adapter 的 companionSocket
    private val provider = LocationManager.GPS_PROVIDER
    private lateinit var lm: LocationManager
    @Volatile private var running = false

    override fun onCreate() {
        super.onCreate()
        lm = getSystemService(LOCATION_SERVICE) as LocationManager
        registerProvider()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundNotification()
        if (!running) {
            running = true
            thread(name = "mock-socket") { serve() }
        }
        return START_STICKY
    }

    private fun registerProvider() {
        runCatching { lm.removeTestProvider(provider) }
        lm.addTestProvider(
            provider,
            false, false, false, false, true, true, true,
            ProviderProperties.POWER_USAGE_LOW,
            ProviderProperties.ACCURACY_FINE,
        )
        lm.setTestProviderEnabled(provider, true)
    }

    /** 監聽 adb forward 過來的連線，逐行讀取 "lat,lng" 並注入。 */
    private fun serve() {
        val server = LocalServerSocket(socketName)
        while (running) {
            val client = server.accept()
            client.inputStream.bufferedReader().use { reader ->
                reader.forEachLine { line ->
                    val parts = line.trim().split(",")
                    if (parts.size == 2) {
                        val lat = parts[0].toDoubleOrNull()
                        val lng = parts[1].toDoubleOrNull()
                        if (lat != null && lng != null) push(lat, lng)
                    }
                }
            }
        }
    }

    private fun push(lat: Double, lng: Double) {
        val loc = Location(provider).apply {
            latitude = lat
            longitude = lng
            accuracy = 5f
            time = System.currentTimeMillis()
            elapsedRealtimeNanos = SystemClock.elapsedRealtimeNanos()
        }
        runCatching { lm.setTestProviderLocation(provider, loc) }
    }

    private fun startForegroundNotification() {
        // 省略：建立 NotificationChannel 後 startForeground(id, notification)
        // foregroundServiceType 須為 location
    }

    override fun onDestroy() {
        running = false
        runCatching { lm.removeTestProvider(provider) }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
