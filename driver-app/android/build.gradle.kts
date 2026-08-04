allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
subprojects {
    project.evaluationDependsOn(":app")

    // Algunos plugins (ej. tflite_flutter) no fijan su propio JVM target y
    // Gradle termina infiriendolo del JDK activo, lo que no coincide con
    // sourceCompatibility=17 del modulo :app y rompe el build con
    // "Inconsistent JVM Target Compatibility Between Java and Kotlin Tasks".
    // Se usa configureEach (perezoso) en vez de afterEvaluate para evitar
    // el error "project is already evaluated" con evaluationDependsOn.
    tasks.withType<org.gradle.api.tasks.compile.JavaCompile>().configureEach {
        sourceCompatibility = "17"
        targetCompatibility = "17"
    }
    tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
        compilerOptions.jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }

    // tflite_flutter, flutter_tts y mapbox_maps_flutter fijan su propio
    // target Java/Kotlin (via su
    // bloque `android { compileOptions {} }`) mas tarde en su evaluacion,
    // pisando el configureEach de arriba (intentar forzarlos a 17 pierde
    // esa carrera). En vez de pelear por eso, se deja su Kotlin igualado a
    // lo que cada modulo use realmente para Java.
    if (project.name == "tflite_flutter" ||
        project.name == "flutter_tts" ||
        project.name == "mapbox_maps_flutter") {
        tasks.withType<org.gradle.api.tasks.compile.JavaCompile>().configureEach {
            logger.lifecycle("${project.name} JavaCompile target: $targetCompatibility")
        }
        tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
            compilerOptions.jvmTarget.set(
                if (project.name == "mapbox_maps_flutter") {
                    org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_1_8
                } else {
                    org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_11
                }
            )
        }
    }
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
