package dev.chatgpt2.remote;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.hardware.Camera;
import android.hardware.Camera.Parameters;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ImageFormat;
import android.graphics.Rect;
import android.view.MotionEvent;
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
import com.google.zxing.RGBLuminanceSource;
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
    private boolean continuousFocus;
    private static final int PICK_IMAGE = 77;
    private final Handler focusHandler = new Handler(Looper.getMainLooper());
    private final Runnable focusLoop = new Runnable() {
        @Override public void run() {
            if (camera == null || completed || continuousFocus) return;
            try { camera.autoFocus((success, activeCamera) -> { }); } catch (Exception ignored) { }
            focusHandler.postDelayed(this, 1500);
        }
    };
    private final Map<DecodeHintType, Object> decodeHints = new EnumMap<>(DecodeHintType.class);

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.BLACK); getWindow().setNavigationBarColor(Color.BLACK);
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(Color.BLACK);
        SurfaceView preview = new SurfaceView(this); holder = preview.getHolder(); holder.addCallback(this); root.addView(preview, new LinearLayout.LayoutParams(-1, 0, 1));
        instructions = new TextView(this); instructions.setText("Apunta la cámara al QR de ChatGPT 2"); instructions.setTextColor(Color.WHITE); instructions.setTextSize(16); instructions.setGravity(Gravity.CENTER); instructions.setPadding(0, 28, 0, 28); root.addView(instructions, new LinearLayout.LayoutParams(-1, -2));
        TextView cancel = new TextView(this); cancel.setText("Cancelar"); cancel.setTextColor(Color.rgb(16, 163, 127)); cancel.setTextSize(15); cancel.setGravity(Gravity.CENTER); cancel.setPadding(0, 18, 0, 25); cancel.setOnClickListener(v -> finish()); root.addView(cancel, new LinearLayout.LayoutParams(-1, -2));
        TextView pick = new TextView(this); pick.setText("¿No enfoca? Elegir una foto del QR"); pick.setTextColor(Color.WHITE); pick.setTextSize(15); pick.setGravity(Gravity.CENTER); pick.setPadding(0, 14, 0, 14); pick.setOnClickListener(v -> pickPhoto()); root.addView(pick, 2);
        preview.setOnTouchListener((view, event) -> { if (event.getAction() == MotionEvent.ACTION_UP) tapToFocus(event.getX(), event.getY(), view.getWidth(), view.getHeight()); return true; });
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
            camera = openBackCamera(); camera.setDisplayOrientation(90);
            Parameters parameters = camera.getParameters();
            parameters.setPreviewFormat(ImageFormat.NV21);
            java.util.List<String> modes = parameters.getSupportedFocusModes();
            continuousFocus = false;
            if (modes != null && modes.contains(Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) { parameters.setFocusMode(Parameters.FOCUS_MODE_CONTINUOUS_PICTURE); continuousFocus = true; }
            else if (modes != null && modes.contains(Parameters.FOCUS_MODE_AUTO)) parameters.setFocusMode(Parameters.FOCUS_MODE_AUTO);
            // Una vista previa de ~1280x720 se enfoca y decodifica mejor que la máxima; sin zoom digital (acerca el enfoque mínimo).
            Camera.Size best = null; long bestScore = Long.MAX_VALUE;
            for (Camera.Size size : parameters.getSupportedPreviewSizes()) { long score = Math.abs((long) size.width * size.height - 1280L * 720L); if (score < bestScore) { bestScore = score; best = size; } }
            if (best != null) parameters.setPreviewSize(best.width, best.height);
            camera.setParameters(parameters); camera.setPreviewDisplay(holder); camera.setPreviewCallback(this); camera.startPreview();
            focusHandler.removeCallbacks(focusLoop); focusHandler.post(focusLoop);
        } catch (Exception error) { closeCamera(); if (instructions != null) instructions.setText("No se pudo abrir la cámara. Revisa el permiso de cámara."); }
    }

    /** Cámara trasera principal: Camera.open() sin id puede abrir un sensor sin enfoque en teléfonos con varias cámaras. */
    private Camera openBackCamera() {
        Camera.CameraInfo info = new Camera.CameraInfo();
        int fallback = -1;
        for (int id = 0; id < Camera.getNumberOfCameras(); id++) {
            Camera.getCameraInfo(id, info);
            if (info.facing != Camera.CameraInfo.CAMERA_FACING_BACK) continue;
            if (fallback < 0) fallback = id;
            try {
                Camera candidate = Camera.open(id);
                java.util.List<String> modes = candidate.getParameters().getSupportedFocusModes();
                if (modes != null && (modes.contains(Parameters.FOCUS_MODE_CONTINUOUS_PICTURE) || modes.contains(Parameters.FOCUS_MODE_AUTO))) return candidate;
                candidate.release();
            } catch (Exception ignored) { }
        }
        return fallback >= 0 ? Camera.open(fallback) : Camera.open();
    }

    /** Tocar la pantalla enfoca ahí; pasados 2 s se vuelve al enfoque continuo. */
    private void tapToFocus(float x, float y, int width, int height) {
        if (camera == null || completed || width == 0 || height == 0) return;
        try {
            Parameters parameters = camera.getParameters();
            if (parameters.getMaxNumFocusAreas() > 0) {
                int cx = (int) (x / width * 2000 - 1000), cy = (int) (y / height * 2000 - 1000);
                Rect area = new Rect(Math.max(-1000, cx - 150), Math.max(-1000, cy - 150), Math.min(1000, cx + 150), Math.min(1000, cy + 150));
                parameters.setFocusAreas(Collections.singletonList(new Camera.Area(area, 800)));
                parameters.setMeteringAreas(parameters.getMaxNumMeteringAreas() > 0 ? Collections.singletonList(new Camera.Area(area, 800)) : null);
                camera.setParameters(parameters);
            }
            camera.cancelAutoFocus();
            camera.autoFocus((ok, active) -> focusHandler.postDelayed(() -> { try { if (camera != null) camera.cancelAutoFocus(); } catch (Exception ignored) { } }, 2000));
        } catch (Exception ignored) { }
    }

    private void pickPhoto() {
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT); intent.setType("image/*");
        try { startActivityForResult(Intent.createChooser(intent, "Foto del QR"), PICK_IMAGE); } catch (Exception error) { instructions.setText("No hay galería disponible."); }
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != PICK_IMAGE || result != RESULT_OK || data == null || data.getData() == null) return;
        instructions.setText("Leyendo la foto…");
        final android.net.Uri uri = data.getData();
        decoder.execute(() -> {
            String text = null;
            try {
                BitmapFactory.Options bounds = new BitmapFactory.Options(); bounds.inJustDecodeBounds = true;
                try (java.io.InputStream in = getContentResolver().openInputStream(uri)) { BitmapFactory.decodeStream(in, null, bounds); }
                for (int sample : new int[] { Math.max(1, Math.max(bounds.outWidth, bounds.outHeight) / 2000), Math.max(1, Math.max(bounds.outWidth, bounds.outHeight) / 1000) }) {
                    BitmapFactory.Options opts = new BitmapFactory.Options(); opts.inSampleSize = sample;
                    Bitmap bitmap; try (java.io.InputStream in = getContentResolver().openInputStream(uri)) { bitmap = BitmapFactory.decodeStream(in, null, opts); }
                    if (bitmap == null) continue;
                    int[] pixels = new int[bitmap.getWidth() * bitmap.getHeight()]; bitmap.getPixels(pixels, 0, bitmap.getWidth(), 0, 0, bitmap.getWidth(), bitmap.getHeight());
                    try { text = new QRCodeReader().decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(bitmap.getWidth(), bitmap.getHeight(), pixels))), decodeHints).getText(); } catch (Exception ignored) { }
                    bitmap.recycle();
                    if (text != null) break;
                }
            } catch (Exception ignored) { }
            final String found = text;
            runOnUiThread(() -> {
                if (found != null && (found.startsWith("F1|") || found.startsWith("F3|") || found.startsWith("F4|"))) finishWith(found);
                else instructions.setText("No encontré un QR de ChatGPT 2 en esa foto. Haz la foto más de cerca y con el QR entero.");
            });
        });
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
