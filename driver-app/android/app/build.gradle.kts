plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
    id("com.google.gms.google-services")
}

val fleetKeystorePath = System.getenv("FLEET_KEYSTORE_PATH")
val fleetKeystorePassword = System.getenv("FLEET_KEYSTORE_PASSWORD")
val fleetKeyAlias = System.getenv("FLEET_KEY_ALIAS")
val fleetKeyPassword = System.getenv("FLEET_KEY_PASSWORD")
val fleetSigningReady = listOf(
    fleetKeystorePath,
    fleetKeystorePassword,
    fleetKeyAlias,
    fleetKeyPassword,
).all { !it.isNullOrBlank() }

gradle.taskGraph.whenReady {
    if (allTasks.any { it.name.contains("Release", ignoreCase = true) } && !fleetSigningReady) {
        throw GradleException(
            "Release signing is not configured. Define all FLEET_KEYSTORE_* variables."
        )
    }
}

android {
    namespace = "com.example.fleet_driver_app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        isCoreLibraryDesugaringEnabled = true
    }

    defaultConfig {
        // Debe coincidir con la ficha existente del conductor en Google Play.
        // El dashboard/Firebase sigue siendo compartido con pasajeros.
        applicationId = "apl.tucompras.com"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        if (fleetSigningReady) {
            create("fleetRelease") {
                storeFile = file(fleetKeystorePath!!)
                storePassword = fleetKeystorePassword
                keyAlias = fleetKeyAlias
                keyPassword = fleetKeyPassword
            }
        }
    }

    buildTypes {
        release {
            // Un release sin las cuatro variables falla al configurar Gradle.
            // Nunca se usa la llave debug ni se genera un artefacto ambiguo.
            signingConfig = if (fleetSigningReady) {
                signingConfigs.getByName("fleetRelease")
            } else {
                null
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")
}
