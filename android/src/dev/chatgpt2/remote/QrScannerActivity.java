package dev.chatgpt2.remote;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.hardware.Camera;
import android.hardware.Camera.Parameters;
import android.graphics.ImageFormat;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeReader;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.DecodeHintType;
import com.google.zxing.BarcodeFormat;
import java.util.Arrays;
import java.util.Collections;
import java.util.EnumMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/** Camera-only QR reader. Frames never leave the phone and are discarded immediately. */
@SuppressWarnings("deprecation")
public final class QrScannerActivity extends Activity implements SurfaceHolder.Callback, Camera.PreviewCallback {
    public static final String RESULT_PAYLOAD = "forja.pairing.payload";
    private final ExecutorService decoder = Executors.newSingleThreadExecutor();
    private final AtomicBoolean decoding = new AtomicBoolean(false);
    private SurfaceHolder holder;
    private Camera camera;
    private boolean completed;
    private TextView instructions;
    private int frameNumber;
    private final Handler focusHandler = new Handler(Looper.getMainLooper());
    private final Runnable focusLoop = new Runnable() {
        @Override public void run() {
            if (camera == null || completed) return;
            try { camera.autoFocus((success, activeCamera) -> { }); } catch (Exception ignored) { }
            focusHandler.postDelayed(this, 1200);
        }
    };
    private final Map<DecodeHintType, Object> decodeHints = new EnumMap<>(DecodeHintType.class);

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.BLACK); getWindow().setNavigationBarColor(Color.BLACK);
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(Color.BLACK);
        SurfaceView preview = new SurfaceView(this); holder = preview.getHolder(); holder.addCallback(this); root.addView(preview, new LinearLayout.LayoutParams(-1, 0, 1));
        instructions = new TextView(this); instructions.setText("Apunta la cámara al QR de ChatGPT 2"); instructions.setTextColor(Color.WHITE); instructions.setTextSize(16); instructions.setGravity(Gravity.CENTER); instructions.setPadding(0, 28, 0, 28); root.addView(instructions, new LinearLayout.LayoutParams(-1, -2));
        TextView cancel = new TextView(this); cancel.setText("Cancelar"); cancel.setTextColor(Color.rgb(242, 118, 53)); cancel.setTextSize(15); cancel.setGravity(Gravity.CENTER); cancel.setPadding(0, 18, 0, 25); cancel.setOnClickListener(v -> finish()); root.addView(cancel, new LinearLayout.LayoutParams(-1, -2));
        setContentView(root);
        decodeHints.put(DecodeHintType.POSSIBLE_FORMATS, Collections.singletonList(BarcodeFormat.QR_CODE));
        decodeHints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        decodeHints.put(DecodeHintType.CHARACTER_SET, "UTF-8");
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) requestPermissions(new String[] { Manifest.permission.CAMERA }, 9);
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] grants) { super.onRequestPermissionsResult(request, permissions, grants); if (request == 9 && grants.length > 0 && grants[0] == PackageManager.PERMISSION_GRANTED) openCamera(); else finish(); }
    @Override public void surfaceCreated(SurfaceHolder unused) { if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) openCamera(); }
    @Override public void surfaceChanged(SurfaceHolder unused, int format, int width, int height) { }
    @Override public void surfaceDestroyed(SurfaceHolder unused) { closeCamera(); }
    @Override protected void onDestroy() { closeCamera(); decoder.shutdownNow(); super.onDestroy(); }

    private void openCamera() {
        if (camera != null || holder == null || completed) return;
        try {
            camera = Camera.open(); camera.setDisplayOrientation(90);
            Parameters parameters = camera.getParameters();
            parameters.setPreviewFormat(ImageFormat.NV21);
            if (parameters.getSupportedFocusModes().contains(Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) parameters.setFocusMode(Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
            if (parameters.isZoomSupported()) {
                // The desktop QR is often small on a wide monitor. A modest digital zoom makes
                // its modules large enough for the phone sensor without cropping the whole view.
                int targetZoom = 0;
                int targetRatio = 200;
                java.util.List<Integer> ratios = parameters.getZoomRatios();
                for (int index = 0; index < ratios.size(); index++) {
                    if (ratios.get(index) <= targetRatio) targetZoom = index;
                }
                parameters.setZoom(Math.min(targetZoom, parameters.getMaxZoom()));
            }
            camera.setParameters(parameters); camera.setPreviewDisplay(holder); camera.setPreviewCallback(this); camera.startPreview();
            focusHandler.removeCallbacks(focusLoop); focusHandler.post(focusLoop);
        } catch (Exception error) { closeCamera(); if (instructions != null) instructions.setText("No se pudo abrir la cámara. Revisa el permiso de cámara."); }
    }

    private void closeCamera() { focusHandler.removeCallbacks(focusLoop); if (camera == null) return; try { camera.setPreviewCallback(null); camera.stopPreview(); camera.release(); } catch (Exception ignored) { } finally { camera = null; } }

    @Override public void onPreviewFrame(byte[] bytes, Camera source) {
        if (completed || ++frameNumber % 2 != 0 || !decoding.compareAndSet(false, true)) return;
        Camera.Size size = source.getParameters().getPreviewSize(); byte[] copy = Arrays.copyOf(bytes, bytes.length);
        decoder.execute(() -> {
            try {
                Result result = decode(copy, size.width, size.height);
                if (result != null && result.getText() != null && (result.getText().startsWith("F1|") || result.getText().startsWith("F3|") || result.getText().startsWith("F4|"))) runOnUiThread(() -> finishWith(result.getText()));
            } catch (Exception ignored) { } finally { decoding.set(false); }
        });
    }

    /** Camera preview buffers are usually landscape even when the activity is portrait. */
    private Result decode(byte[] frame, int width, int height) {
        Result result = decodeOrientation(frame, width, height);
        if (result != null) return result;
        byte[] clockwise = rotateLuma(frame, width, height, true);
        result = decodeOrientation(clockwise, height, width);
        if (result != null) return result;
        return decodeOrientation(rotateLuma(frame, width, height, false), height, width);
    }

    private Result decodeOrientation(byte[] frame, int width, int height) {
        try {
            PlanarYUVLuminanceSource source = new PlanarYUVLuminanceSource(frame, width, height, 0, 0, width, height, false);
            return new QRCodeReader().decode(new BinaryBitmap(new HybridBinarizer(source)), decodeHints);
        } catch (Exception ignored) {
            return null;
        }
    }

    private byte[] rotateLuma(byte[] source, int width, int height, boolean clockwise) {
        byte[] rotated = new byte[width * height];
        for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) {
            int target = clockwise ? x * height + (height - 1 - y) : (width - 1 - x) * height + y;
            rotated[target] = source[y * width + x];
        }
        return rotated;
    }

    private void finishWith(String payload) { if (completed) return; completed = true; closeCamera(); setResult(RESULT_OK, new Intent().putExtra(RESULT_PAYLOAD, payload)); finish(); }
}
