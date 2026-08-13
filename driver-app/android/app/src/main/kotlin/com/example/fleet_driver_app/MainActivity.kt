package com.example.fleet_driver_app

import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private val channelName = "apl.tucompras/settings"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName)
            .setMethodCallHandler { call, result ->
                if (call.method != "openSettings") {
                    result.notImplemented()
                    return@setMethodCallHandler
                }

                val route = call.argument<String>("route") ?: "app_details"
                val component = call.argument<String>("component")
                val intent = when (route) {
                    "permissions" -> miuiAppPermissionsIntent() ?: appDetailsIntent()
                    "notifications" -> Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                        putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                    }
                    "battery" -> miuiBatteryIntent() ?: Intent(
                        Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
                    ).apply { data = Uri.parse("package:$packageName") }
                    "autostart" -> miuiAutostartIntent() ?: appDetailsIntent()
                    "component" -> component?.let {
                        Intent().setComponent(ComponentName.unflattenFromString(it))
                    } ?: appDetailsIntent()
                    else -> appDetailsIntent()
                }

                try {
                    startActivity(intent)
                    result.success(true)
                } catch (_: Exception) {
                    // Algunos modelos cambian la actividad OEM entre versiones.
                    // Siempre dejamos al conductor en los detalles de la app.
                    try {
                        startActivity(appDetailsIntent())
                        result.success(true)
                    } catch (_: Exception) {
                        result.success(false)
                    }
                }
            }
    }

    private fun appDetailsIntent(): Intent = Intent(
        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
        Uri.parse("package:$packageName")
    )

    private fun isXiaomi(): Boolean {
        val maker = "${Build.MANUFACTURER} ${Build.BRAND}".lowercase()
        return maker.contains("xiaomi") || maker.contains("redmi") || maker.contains("poco")
    }

    private fun miuiAppPermissionsIntent(): Intent? {
        if (!isXiaomi()) return null
        return Intent("miui.intent.action.APP_PERM_EDITOR").apply {
            addCategory(Intent.CATEGORY_DEFAULT)
            putExtra("extra_pkgname", packageName)
        }
    }

    private fun miuiAutostartIntent(): Intent? {
        if (!isXiaomi()) return null
        // MIUI expone únicamente la lista global de inicio automático. No
        // acepta un filtro por paquete; la pantalla muestra la app instalada
        // para que el conductor active APL Conductor.
        return Intent().setComponent(
            ComponentName(
                "com.miui.securitycenter",
                "com.miui.permcenter.autostart.AutoStartManagementActivity"
            )
        )
    }

    private fun miuiBatteryIntent(): Intent? {
        if (!isXiaomi()) return null
        return Intent().apply {
            component = ComponentName(
                "com.miui.powerkeeper",
                "com.miui.powerkeeper.ui.HiddenAppsConfigActivity"
            )
            putExtra("package_name", packageName)
            putExtra("package_label", applicationInfo.loadLabel(packageManager).toString())
        }
    }
}
