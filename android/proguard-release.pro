# Keep only Android entry points by their manifest names. R8 can shrink and rename all other
# application implementation details in signed release APKs.
-keep,allowoptimization class dev.forja.remote.MainActivity { <init>(); }
-keep,allowoptimization class dev.forja.remote.QrScannerActivity { <init>(); }
-keep class com.google.zxing.** { *; }
-dontwarn javax.annotation.**
