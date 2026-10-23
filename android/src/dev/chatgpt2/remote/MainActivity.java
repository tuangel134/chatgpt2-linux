package dev.chatgpt2.remote;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.Dialog;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.BroadcastReceiver;
import android.content.IntentFilter;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.ValueCallback;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.InputType;
import android.util.Base64;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewTreeObserver;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.*;
import android.graphics.drawable.GradientDrawable;
import org.json.*;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URI;
import java.net.URL;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.security.SecureRandom;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

/** The mobile face of Forja: a compact, native chat that never stores a desktop bearer in a QR. */
public final class MainActivity extends Activity {
    private static final int SCAN_QR = 41;
	private static final int UNLOCK_CHAT = 42;
	private static final int MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
	private static final String KEYSTORE_ALIAS = "forja.remote.preferences";
    private static final int BG = Color.rgb(24, 24, 24), SURFACE = Color.rgb(32, 32, 32), SURFACE_RAISED = Color.rgb(42, 42, 42);
    private static final int TEXT = Color.rgb(244, 239, 233), MUTED = Color.rgb(174, 165, 154), AMBER = Color.rgb(16, 163, 127), GREEN = Color.rgb(99, 198, 128);
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private EditText endpoint, pairingCode, composer;
    private TextView status, projectName, connectionDot;
    private LinearLayout pairingCard, manualFields, messages, composerShell;
    private ScrollView chatScroll;
    private String token = "", workspaceId = "", workspaceName = "", sessionId = "";
    /** Empty means ChatGPT 2 Native; otherwise delegate the turn to a local subscription CLI. */
    private String externalAgent = "";
    private String localToken = "", localEndpoint = "";
    private String relayInstallation = "", relayKey = "", relayEncryptionKey = "", relayDeviceToken = "";
    /** Snapshot returned by the desktop; it powers the project switcher without exposing secrets. */
    private JSONArray availableWorkspaces = new JSONArray();
    /** Responses pulled for another in-flight relay command must not be discarded. */
    private final Map<String, JSONObject> pendingRelayResponses = new ConcurrentHashMap<>();
    // Interfaz del chat: una página local (assets/app) dentro de un WebView; aquí solo viven el emparejamiento, el cifrado y el relay.
    private WebView web; private boolean webMode, webLoaded; private LinearLayout rootView, headerView;
    private final ExecutorService calls = Executors.newFixedThreadPool(4);
    private ValueCallback<Uri[]> fileCallback; private static final int PICK_FILES = 55;
    private boolean anywhere;
	private boolean appUnlocked, unlockInFlight, unlockRetrySuppressed, activityResumed, refreshInFlight, sendInFlight, captureInFlight;
	private long lastLeftAt;
	private int unlockWaitAttempts;
	private static final long UNLOCK_GRACE_MS = 30000L;
	private static final int MAX_UNLOCK_WAIT_ATTEMPTS = 20;
	private final Runnable unlockWhenReady = new Runnable() { @Override public void run() { requestDeviceUnlock(); } };
	private final BroadcastReceiver screenOffReceiver = new BroadcastReceiver() {
		@Override public void onReceive(Context context, Intent intent) {
			if (Intent.ACTION_SCREEN_OFF.equals(intent.getAction()) && connected()) {
				appUnlocked = false; unlockRetrySuppressed = false; unlockWaitAttempts = 0;
				main.removeCallbacks(unlockWhenReady);
				showPairing();
			}
		}
	};
    private Dialog remoteBrowserDialog;
    private Spinner remotePagePicker;
    private ImageView remotePageImage;
    private TextView remoteBrowserStatus, remotePageInfo;
    private EditText remoteBrowserAddress, remoteBrowserInput;
    private Button remoteShareButton, remoteUnshareButton, remoteBrowserGo;
    private JSONArray remotePages = new JSONArray();
    private String remotePageId = "";
    private Bitmap remoteBrowserBitmap;
    private float remoteTouchX, remoteTouchY;
    private boolean remoteTouchActive;
    private final Runnable refreshLoop = new Runnable() { public void run() { if (connected() && appUnlocked && !webMode) refresh(); main.postDelayed(this, 3500); } };

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(BG); getWindow().setNavigationBarColor(BG); getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
		token = loadSecret("token"); workspaceId = getPreferences(MODE_PRIVATE).getString("workspace", "");
		localToken = loadSecret("localToken"); localEndpoint = getPreferences(MODE_PRIVATE).getString("localEndpoint", "");
        workspaceName = getPreferences(MODE_PRIVATE).getString("workspaceName", "ChatGPT 2"); sessionId = getPreferences(MODE_PRIVATE).getString("session", "");
        externalAgent = getPreferences(MODE_PRIVATE).getString("externalAgent", "");
        anywhere = "anywhere".equals(getPreferences(MODE_PRIVATE).getString("remoteMode", ""));
		relayInstallation = getPreferences(MODE_PRIVATE).getString("relayInstallation", ""); relayKey = loadSecret("relayKey");
		relayEncryptionKey = loadSecret("relayEncryptionKey"); relayDeviceToken = loadSecret("relayDeviceToken");
        build();
		registerReceiver(screenOffReceiver, new IntentFilter(Intent.ACTION_SCREEN_OFF));
        if (connected()) { showPairing(); }
        else {
            showPairing();
            // Diagnóstico: distinguir «el sistema borró la llave de seguridad» de «la app llegó sin datos» (instalación limpia o desinstalada antes).
            SharedPreferences p = getPreferences(MODE_PRIVATE);
            if (!p.getString("secret.relayDeviceToken", "").isEmpty() || !p.getString("fsecret.relayDeviceToken", "").isEmpty() || !p.getString("relayInstallation", "").isEmpty()) setStatus("Se conservaron los datos pero el teléfono ya no puede leer las claves guardadas (borró la llave de seguridad). Escanea el QR otra vez. v" + versionLabel());
            else setStatus("Sin emparejar (la app no tenía datos guardados: instalación nueva o desinstalada antes). v" + versionLabel());
        }
        main.postDelayed(refreshLoop, 3500);
    }

    @Override protected void onDestroy() { main.removeCallbacks(refreshLoop); main.removeCallbacks(unlockWhenReady); unlockInFlight = false; unregisterReceiver(screenOffReceiver); io.shutdownNow(); calls.shutdownNow(); if (web != null) web.destroy(); super.onDestroy(); }
	@Override protected void onStart() {
		super.onStart();
		if (connected() && lastLeftAt > 0 && SystemClock.elapsedRealtime() - lastLeftAt > UNLOCK_GRACE_MS) {
			appUnlocked = false;
			unlockRetrySuppressed = false;
			showPairing();
		}
	}
	@Override protected void onResume() { super.onResume(); activityResumed = true; unlockWaitAttempts = 0; requestDeviceUnlock(); }
	@Override protected void onPause() { activityResumed = false; main.removeCallbacks(unlockWhenReady); super.onPause(); }
	@Override protected void onStop() { lastLeftAt = SystemClock.elapsedRealtime(); super.onStop(); }
	@Override public void onWindowFocusChanged(boolean hasFocus) {
		super.onWindowFocusChanged(hasFocus);
		if (hasFocus) { unlockWaitAttempts = 0; requestDeviceUnlock(); }
	}

    private void build() {
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(BG);
        // This app is edge-to-edge on several Android skins; reserve the status-bar area explicitly.
        final int sideInset = dp(16), topInset = dp(34), bottomInset = dp(10);
        root.setPadding(sideInset, topInset, sideInset, bottomInset);
        // Android 15 can ignore adjustResize for edge-to-edge windows. The visible display frame is
        // reliable on API 26+, so compensate for the IME ourselves and keep the composer reachable.
        root.getViewTreeObserver().addOnGlobalLayoutListener(new ViewTreeObserver.OnGlobalLayoutListener() {
            @Override public void onGlobalLayout() {
                Rect frame = new Rect(); root.getWindowVisibleDisplayFrame(frame);
                int obscured = Math.max(0, root.getRootView().getHeight() - frame.bottom);
                int keyboardInset = obscured > root.getRootView().getHeight() / 5 ? obscured : 0;
                int desiredBottom = bottomInset + keyboardInset;
                int side = webMode ? 0 : sideInset; if (root.getPaddingBottom() != desiredBottom || root.getPaddingLeft() != side) root.setPadding(side, topInset, side, desiredBottom);
            }
        });

        LinearLayout header = row(); header.setPadding(0, dp(4), 0, dp(12)); headerView = header; rootView = root;
        ImageView mark = new ImageView(this); mark.setImageResource(getResources().getIdentifier("forja_logo_mark", "drawable", getPackageName())); mark.setContentDescription("ChatGPT 2"); mark.setPadding(0, dp(2), dp(8), dp(2)); header.addView(mark, new LinearLayout.LayoutParams(dp(48), dp(44)));
        LinearLayout heading = new LinearLayout(this); heading.setOrientation(LinearLayout.VERTICAL); heading.setPadding(dp(9), 0, 0, 0);
        projectName = label("CHATGPT 2 REMOTE  ▾", 16, TEXT); projectName.setTypeface(Typeface.DEFAULT, Typeface.BOLD); projectName.setOnClickListener(v -> chooseProject()); heading.addView(projectName);
        status = label("Controla tu espacio de trabajo", 12, MUTED); heading.addView(status); header.addView(heading, weight());
        connectionDot = label("●", 16, MUTED); connectionDot.setGravity(Gravity.CENTER); header.addView(connectionDot, new LinearLayout.LayoutParams(dp(28), dp(38)));
        ImageButton browser = new ImageButton(this); browser.setImageResource(android.R.drawable.ic_menu_view); browser.setColorFilter(TEXT); browser.setBackgroundColor(Color.TRANSPARENT); browser.setContentDescription("Navegador ChatGPT y Perplexity"); browser.setOnClickListener(v -> openBrowserChooser()); 
        ImageButton menu = new ImageButton(this); menu.setImageResource(android.R.drawable.ic_menu_more); menu.setColorFilter(TEXT); menu.setBackgroundColor(Color.TRANSPARENT); menu.setContentDescription("Acciones de ChatGPT 2"); menu.setOnClickListener(v -> showControls()); header.addView(menu, new LinearLayout.LayoutParams(dp(42), dp(42)));
        root.addView(header, fill());

        pairingCard = new LinearLayout(this); pairingCard.setOrientation(LinearLayout.VERTICAL); pairingCard.setPadding(dp(16), dp(16), dp(16), dp(14)); pairingCard.setBackground(card(SURFACE, 14));
        TextView pairTitle = label("Conecta tu escritorio", 19, TEXT); pairTitle.setTypeface(Typeface.DEFAULT, Typeface.BOLD); pairingCard.addView(pairTitle);
        TextView pairCopy = label("Escanea el QR que aparece en ChatGPT 2. El acceso remoto seguro funciona desde cualquier red; el QR local sigue disponible para tu Wi-Fi.", 13, MUTED); pairCopy.setLineSpacing(dp(3), 1f); pairCopy.setPadding(0, dp(6), 0, dp(13)); pairingCard.addView(pairCopy);
        Button scan = accentButton("Escanear código QR"); scan.setOnClickListener(v -> startActivityForResult(new Intent(this, QrScannerActivity.class), SCAN_QR)); pairingCard.addView(scan, fill());
        TextView manual = label("Usar dirección y código manualmente", 13, AMBER); manual.setPadding(0, dp(15), 0, dp(5)); manual.setOnClickListener(v -> manualFields.setVisibility(manualFields.getVisibility() == View.VISIBLE ? View.GONE : View.VISIBLE)); pairingCard.addView(manual);
        manualFields = new LinearLayout(this); manualFields.setOrientation(LinearLayout.VERTICAL); manualFields.setVisibility(View.GONE);
        endpoint = input("http://192.168.1.20:48158"); endpoint.setText(getPreferences(MODE_PRIVATE).getString("endpoint", "")); manualFields.addView(endpoint, fill());
        pairingCode = input("Código de 8 caracteres"); pairingCode.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS); manualFields.addView(pairingCode, fill());
        Button pair = accentButton("Emparejar"); pair.setOnClickListener(v -> pair()); manualFields.addView(pair, fill()); pairingCard.addView(manualFields, fill());
        root.addView(pairingCard, fill());

        chatScroll = new ScrollView(this); chatScroll.setFillViewport(true); chatScroll.setClipToPadding(false);
        messages = new LinearLayout(this); messages.setOrientation(LinearLayout.VERTICAL); messages.setPadding(0, dp(7), 0, dp(8)); chatScroll.addView(messages, fill());
        root.addView(chatScroll, new LinearLayout.LayoutParams(-1, 0, 1));

        composerShell = new LinearLayout(this); composerShell.setOrientation(LinearLayout.VERTICAL); composerShell.setPadding(dp(12), dp(8), dp(8), dp(8)); composerShell.setBackground(card(SURFACE, 14));
        composer = input("Pídele algo a ChatGPT 2…"); composer.setMinLines(1); composer.setMaxLines(4); composer.setGravity(Gravity.TOP | Gravity.START); composer.setBackgroundColor(Color.TRANSPARENT); composer.setOnFocusChangeListener((view, focused) -> { if (focused) chatScroll.post(() -> chatScroll.fullScroll(View.FOCUS_DOWN)); }); composer.setOnClickListener(view -> chatScroll.post(() -> chatScroll.fullScroll(View.FOCUS_DOWN))); composerShell.addView(composer, fill());
        LinearLayout actions = row(); actions.setPadding(0, dp(4), 0, 0);
        actions.addView(new View(this), weight());
        Button capture = quietButton("Captura"); capture.setOnClickListener(v -> capture()); actions.addView(capture);
        Button send = accentButton("Enviar ↑"); send.setOnClickListener(v -> send()); actions.addView(send);
        composerShell.addView(actions, fill()); root.addView(composerShell, fill());
        web = new WebView(this); web.setBackgroundColor(Color.rgb(23, 23, 23)); web.setVisibility(View.GONE);
        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true); ws.setDomStorageEnabled(true);
        ws.setAllowFileAccess(false); ws.setAllowContentAccess(false); ws.setAllowFileAccessFromFileURLs(false); ws.setAllowUniversalAccessFromFileURLs(false);
        ws.setJavaScriptCanOpenWindowsAutomatically(false); ws.setSupportMultipleWindows(false); ws.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        ws.setTextZoom(100); WebView.setWebContentsDebuggingEnabled(false);
        web.addJavascriptInterface(new Bridge(), "Android");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.startsWith("https://") || url.startsWith("http://")) { try { startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl())); } catch (Exception ignored) { } }
                return true; // la página local nunca navega a otro sitio
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            // Adjuntar fotos y archivos: la página usa <input type="file"> y aquí se abre el selector del sistema.
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try { Intent intent = params.createIntent(); intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true); startActivityForResult(intent, PICK_FILES); }
                catch (Exception error) { fileCallback = null; return false; }
                return true;
            }
        });
        root.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(root);
    }

    private String versionLabel() { try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return "?"; } }
    private void showPairing() { webMode = false; if (web != null) { web.setVisibility(View.GONE); web.loadUrl("about:blank"); webLoaded = false; } if (headerView != null) headerView.setVisibility(View.VISIBLE); if (rootView != null) rootView.setPadding(dp(16), dp(34), dp(16), dp(10)); pendingRelayResponses.clear(); pairingCard.setVisibility(View.VISIBLE); chatScroll.setVisibility(View.GONE); composerShell.setVisibility(View.GONE); connectionDot.setTextColor(MUTED); setProjectTitle(); }
    private void showChat() {
        pairingCard.setVisibility(View.GONE); chatScroll.setVisibility(View.GONE); composerShell.setVisibility(View.GONE); headerView.setVisibility(View.GONE);
        webMode = true; web.setVisibility(View.VISIBLE); rootView.setPadding(0, dp(34), 0, dp(0));
        if (!webLoaded) { webLoaded = true; web.loadUrl("file:///android_asset/app/index.html"); }
    }
    /** Puente JavaScript ↔ relay: la página pide órdenes (estado, mensajes, enviar...) y aquí se cifran y viajan por el relay. */
    public final class Bridge {
        @android.webkit.JavascriptInterface public void call(String id, String json) {
            calls.execute(() -> {
                try {
                    if (!appUnlocked || !connected()) throw new IOException("La app está bloqueada: desbloquéala con el bloqueo de pantalla.");
                    JSONObject reply = relayRequest(new JSONObject(json));
                    deliver(id, true, reply.toString());
                } catch (Exception error) {
                    String message = String.valueOf(error.getMessage());
                    if (message.contains("no longer paired") || message.contains("Pairing expired") || message.contains("Pair this device first")) { runOnUiThread(() -> { clearPairing(); setStatus("El escritorio revocó este teléfono. Escanea un QR nuevo."); }); }
                    deliver(id, false, message);
                }
            });
        }
        @android.webkit.JavascriptInterface public String version() { return versionLabel(); }
        @android.webkit.JavascriptInterface public void unpair() { runOnUiThread(() -> clearPairing()); }
        /** Guarda en Descargas/ChatGPT 2 un archivo o imagen que mandó la PC. */
        @android.webkit.JavascriptInterface public void saveFile(String name, String mime, String base64) {
            calls.execute(() -> {
                String safe = String.valueOf(name).replaceAll("[\\\\/:*?\"<>|]", "_");
                boolean ok = false;
                try {
                    byte[] data = Base64.decode(base64, Base64.DEFAULT);
                    if (Build.VERSION.SDK_INT >= 29) {
                        ContentValues values = new ContentValues();
                        values.put(MediaStore.Downloads.DISPLAY_NAME, safe); values.put(MediaStore.Downloads.MIME_TYPE, mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                        values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/ChatGPT 2");
                        Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                        if (uri != null) { try (OutputStream out = getContentResolver().openOutputStream(uri)) { out.write(data); ok = true; } }
                    } else {
                        File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS); if (dir != null) { dir.mkdirs(); try (OutputStream out = new FileOutputStream(new File(dir, safe))) { out.write(data); ok = true; } }
                    }
                } catch (Exception ignored) { }
                final boolean done = ok;
                runOnUiThread(() -> { if (web != null) web.evaluateJavascript("window.__saved(" + done + "," + JSONObject.quote(safe) + ")", null); });
            });
        }
    }
    private void deliver(String id, boolean ok, String data) { runOnUiThread(() -> { if (web != null) web.evaluateJavascript("window.__native(" + JSONObject.quote(id) + "," + ok + "," + JSONObject.quote(data) + ")", null); }); }
    @Override public void onBackPressed() {
        if (webMode && web != null && web.getVisibility() == View.VISIBLE) { web.evaluateJavascript("window.__back&&window.__back()", value -> { if (!"true".equals(value)) finish(); }); return; }
        super.onBackPressed();
    }
    private void setProjectTitle() { projectName.setText((workspaceName.isEmpty() ? "CHATGPT 2 REMOTE" : workspaceName.toUpperCase()) + "  ▾"); }
	private void requestDeviceUnlock() {
		if (!activityResumed || !connected() || appUnlocked || unlockInFlight || unlockRetrySuppressed) return;
		KeyguardManager keyguard = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
		if (keyguard == null || !keyguard.isKeyguardSecure()) { showPairing(); setStatus("Configura un bloqueo de pantalla para proteger ChatGPT 2 Remote."); unlockRetrySuppressed = true; return; }
		if (keyguard.isKeyguardLocked() || !getWindow().getDecorView().hasWindowFocus()) {
			if (unlockWaitAttempts++ < MAX_UNLOCK_WAIT_ATTEMPTS) {
				main.removeCallbacks(unlockWhenReady);
				main.postDelayed(unlockWhenReady, 500);
			}
			return;
		}
		main.removeCallbacks(unlockWhenReady);
		unlockWaitAttempts = 0;
		Intent intent = keyguard.createConfirmDeviceCredentialIntent("Desbloquear ChatGPT 2 Remote", "Confirma el bloqueo del dispositivo para abrir el chat.");
		if (intent == null) { showPairing(); setStatus("No se pudo solicitar el desbloqueo del dispositivo."); unlockRetrySuppressed = true; return; }
		unlockInFlight = true;
		try { startActivityForResult(intent, UNLOCK_CHAT); }
		catch (Exception error) { unlockInFlight = false; unlockRetrySuppressed = true; showPairing(); setStatus("No se pudo abrir la confirmación de seguridad."); }
	}

    private void pair() {
        final String base = normalize(endpoint.getText().toString()); final String code = pairingCode.getText().toString().trim();
        if (base.isEmpty()) { setStatus("Dirección inválida: usa HTTPS o una dirección local HTTP."); return; }
        if (code.length() < 6) { setStatus("Escanea el QR o escribe el código de emparejamiento."); return; }
        setStatus("Emparejando…");
        io.execute(() -> { try {
            JSONObject reply = request(base, "POST", "/api/v1/pair", new JSONObject().put("code", code).put("deviceName", android.os.Build.MODEL).put("platform", "android"), ""); token = reply.getString("token"); localToken = token; localEndpoint = base; anywhere = false; relayInstallation = ""; relayKey = ""; relayEncryptionKey = ""; relayDeviceToken = ""; JSONArray spaces = reply.getJSONArray("workspaces"); rememberWorkspaces(spaces);
            if (spaces.length() == 0) throw new IOException("No hay proyectos abiertos en ChatGPT 2.");
            JSONObject space = spaces.getJSONObject(0); workspaceId = space.getString("id"); workspaceName = space.optString("name", "ChatGPT 2"); sessionId = latestSession(space);
			saveSecret("token", token); saveSecret("localToken", localToken); removeSecret("relayKey"); removeSecret("relayEncryptionKey"); removeSecret("relayDeviceToken");
			getPreferences(MODE_PRIVATE).edit().putString("endpoint", base).putString("localEndpoint", localEndpoint).putString("workspace", workspaceId).putString("workspaceName", workspaceName).putString("session", sessionId).remove("remoteMode").remove("relayInstallation").apply();
            ui(() -> { setStatus("Conectado al escritorio"); unlockRetrySuppressed = false; requestDeviceUnlock(); });
        } catch (Exception error) { ui(() -> setStatus("No se pudo emparejar: " + error.getMessage())); } });
    }

    private void refresh() {
		if (!appUnlocked || !connected() || workspaceId.isEmpty() || refreshInFlight || sendInFlight) return;
		refreshInFlight = true;
        if (anywhere) { refreshAnywhere(); return; }
        final String base = normalize(endpoint.getText().toString());
        io.execute(() -> { try {
            JSONObject statusReply = request(base, "GET", "/api/v1/status", null, token); JSONArray spaces = statusReply.getJSONArray("workspaces"); rememberWorkspaces(spaces); boolean foundWorkspace = false;
            for (int i = 0; i < spaces.length(); i++) if (workspaceId.equals(spaces.getJSONObject(i).getString("id"))) { workspaceName = spaces.getJSONObject(i).optString("name", workspaceName); if (sessionId.isEmpty()) sessionId = latestSession(spaces.getJSONObject(i)); foundWorkspace = true; break; }
            // Workspace IDs belong to the desktop process. After a Forja restart, recover the open
            // project and its persisted latest session rather than making the phone pair again.
            if (!foundWorkspace && spaces.length() > 0) { JSONObject space = spaces.getJSONObject(0); workspaceId = space.getString("id"); workspaceName = space.optString("name", "ChatGPT 2"); sessionId = latestSession(space); getPreferences(MODE_PRIVATE).edit().putString("workspace", workspaceId).putString("workspaceName", workspaceName).putString("session", sessionId).apply(); }
            if (sessionId.isEmpty()) { ui(() -> { setStatus("Listo para tu primera orden"); showWelcome(); }); return; }
            JSONObject reply = request(base, "GET", "/api/v1/messages?workspaceId=" + workspaceId + "&sessionId=" + sessionId, null, token);
            ui(() -> { renderMessages(reply.optJSONArray("messages")); setProjectTitle(); setStatus("En línea · sincronizado"); });
        } catch (Exception error) { ui(() -> { if ("Pair this device first.".equals(error.getMessage())) { clearPairing(); setStatus("El escritorio revocó este dispositivo. Escanea el QR para conectarlo de nuevo."); } else { connectionDot.setTextColor(AMBER); setStatus("Sin conexión: " + error.getMessage()); } }); } finally { refreshInFlight = false; } });
    }

	private void pairAnywhere(String base, String installation, String key, String encryptionKey) {
		endpoint.setText(normalize(base)); localToken = ""; localEndpoint = ""; relayInstallation = installation; relayKey = key; relayEncryptionKey = encryptionKey; relayDeviceToken = ""; anywhere = true; token = "";
        setStatus("Emparejando de forma segura…");
        io.execute(() -> { try {
			relayDeviceToken = relayPair();
            JSONObject reply = relayRequest(new JSONObject().put("type", "status")); JSONArray spaces = reply.getJSONArray("workspaces"); rememberWorkspaces(spaces);
            if (spaces.length() == 0) throw new IOException("No hay proyectos abiertos en ChatGPT 2.");
            JSONObject space = spaces.getJSONObject(0); workspaceId = space.getString("id"); workspaceName = space.optString("name", "ChatGPT 2"); sessionId = latestSession(space);
			saveSecret("relayKey", relayKey); saveSecret("relayEncryptionKey", relayEncryptionKey); saveSecret("relayDeviceToken", relayDeviceToken); removeSecret("token");
			getPreferences(MODE_PRIVATE).edit().putString("endpoint", normalize(base)).putString("workspace", workspaceId).putString("workspaceName", workspaceName).putString("session", sessionId).putString("remoteMode", "anywhere").putString("relayInstallation", relayInstallation).apply();
            ui(() -> { setStatus("Canal cifrado emparejado"); unlockRetrySuppressed = false; requestDeviceUnlock(); });
        } catch (Exception error) { anywhere = false; ui(() -> setStatus("No se pudo emparejar: " + error.getMessage())); } });
    }

	private void pairHybrid(String encoded) {
		setStatus("Preparando conexión local y relay…");
		io.execute(() -> { try {
			String[] fields = encoded.split("\\|", -1);
			if (fields.length != 6 || !"F4".equals(fields[0])) throw new IOException("QR híbrido inválido.");
			String relay = ""; /* el QR híbrido (F4) no lo genera ChatGPT 2; solo F3 con la URL de tu relay */ String installation = fields[1]; String key = fields[2]; String encryption = fields[3];
			if (!relay.startsWith("https://") || installation.length() < 32 || key.length() < 43 || encryption.length() < 43) throw new IOException("QR híbrido inválido.");
			String local = normalize(fields[4]); String code = fields[5];
			String localCredential = "";
			if (local.startsWith("http://") && code.length() >= 6) {
				try { localCredential = request(local, "POST", "/api/v1/pair", new JSONObject().put("code", code).put("deviceName", android.os.Build.MODEL).put("platform", "android"), "").optString("token", ""); }
				catch (Exception ignored) { /* The device may be away from the LAN; relay pairing is sufficient. */ }
			}
			endpoint.setText(relay); localEndpoint = local; localToken = localCredential; relayInstallation = installation; relayKey = key; relayEncryptionKey = encryption; relayDeviceToken = relayPair(); anywhere = true; token = "";
			JSONObject reply = relayRequest(new JSONObject().put("type", "status")); JSONArray spaces = reply.getJSONArray("workspaces"); rememberWorkspaces(spaces);
			if (spaces.length() == 0) throw new IOException("No hay proyectos abiertos en ChatGPT 2.");
			JSONObject space = spaces.getJSONObject(0); workspaceId = space.getString("id"); workspaceName = space.optString("name", "ChatGPT 2"); sessionId = latestSession(space);
			saveSecret("localToken", localToken); saveSecret("relayKey", relayKey); saveSecret("relayEncryptionKey", relayEncryptionKey); saveSecret("relayDeviceToken", relayDeviceToken); removeSecret("token");
			getPreferences(MODE_PRIVATE).edit().putString("endpoint", relay).putString("localEndpoint", localEndpoint).putString("workspace", workspaceId).putString("workspaceName", workspaceName).putString("session", sessionId).putString("remoteMode", "anywhere").putString("relayInstallation", relayInstallation).apply();
			ui(() -> { setStatus(localToken.isEmpty() ? "Relay cifrado emparejado" : "LAN + relay emparejados"); unlockRetrySuppressed = false; requestDeviceUnlock(); });
		} catch (Exception error) { anywhere = false; ui(() -> setStatus("No se pudo emparejar: " + error.getMessage())); } });
	}

    private void refreshAnywhere() {
        io.execute(() -> { try {
            JSONObject statusReply;
            boolean usedLocal = false;
            if (!localToken.isEmpty() && !localEndpoint.isEmpty()) {
                try { statusReply = request(normalize(localEndpoint), "GET", "/api/v1/status", null, localToken); usedLocal = true; }
                catch (Exception localError) { statusReply = relayRequest(new JSONObject().put("type", "status")); }
            } else statusReply = relayRequest(new JSONObject().put("type", "status"));
            JSONArray spaces = statusReply.getJSONArray("workspaces"); rememberWorkspaces(spaces); boolean foundWorkspace = false;
            for (int i = 0; i < spaces.length(); i++) if (workspaceId.equals(spaces.getJSONObject(i).getString("id"))) { workspaceName = spaces.getJSONObject(i).optString("name", workspaceName); if (sessionId.isEmpty()) sessionId = latestSession(spaces.getJSONObject(i)); foundWorkspace = true; break; }
            if (!foundWorkspace && spaces.length() > 0) { JSONObject space = spaces.getJSONObject(0); workspaceId = space.getString("id"); workspaceName = space.optString("name", "ChatGPT 2"); sessionId = latestSession(space); getPreferences(MODE_PRIVATE).edit().putString("workspace", workspaceId).putString("workspaceName", workspaceName).putString("session", sessionId).apply(); }
            if (sessionId.isEmpty()) { ui(() -> { setStatus("Listo para tu primera orden"); showWelcome(); }); return; }
			JSONObject reply;
			if (usedLocal) {
				try { reply = request(normalize(localEndpoint), "GET", "/api/v1/messages?workspaceId=" + workspaceId + "&sessionId=" + sessionId, null, localToken); }
				catch (Exception ignored) { reply = relayRequest(new JSONObject().put("type", "messages").put("workspaceId", workspaceId).put("sessionId", sessionId)); }
			} else reply = relayRequest(new JSONObject().put("type", "messages").put("workspaceId", workspaceId).put("sessionId", sessionId));
			final boolean local = usedLocal; final JSONObject rendered = reply;
			ui(() -> { renderMessages(rendered.optJSONArray("messages")); setProjectTitle(); setStatus(local ? "En línea · LAN" : "En línea · relay seguro"); });
        } catch (Exception error) { ui(() -> { if (error.getMessage().contains("Pairing expired")) { clearPairing(); setStatus("El escritorio revocó este acceso. Escanea un QR nuevo."); } else { connectionDot.setTextColor(AMBER); setStatus("Sin conexión: " + error.getMessage()); } }); } });
    }

    private void send() {
		if (!appUnlocked || sendInFlight) return;
		final String text = composer.getText().toString().trim(); if (text.isEmpty()) return;
		sendInFlight = true;
		final String base = normalize(endpoint.getText().toString()); composer.setText("");
        addBubble("user", text); setStatus("ChatGPT 2 está trabajando…"); chatScroll.post(() -> chatScroll.fullScroll(View.FOCUS_DOWN));
        io.execute(() -> { try {
            JSONObject body = new JSONObject().put("workspaceId", workspaceId).put("text", text); if (!sessionId.isEmpty()) body.put("sessionId", sessionId);
			JSONObject reply;
			if (!externalAgent.isEmpty()) {
				body.put("agent", externalAgent).put("permission", "read-only");
				if (anywhere) {
					if (!localToken.isEmpty() && !localEndpoint.isEmpty()) {
						try { reply = request(normalize(localEndpoint), "POST", "/api/v1/external", body, localToken); }
						catch (Exception ignored) { reply = relayRequest(body.put("type", "external-start")); }
					} else reply = relayRequest(body.put("type", "external-start"));
					reply = waitExternalRun(reply.getString("runId"));
				} else {
					reply = request(base, "POST", "/api/v1/external", body, token);
					reply = waitExternalRun(reply.getString("runId"));
				}
			} else if (anywhere) {
				if (!localToken.isEmpty() && !localEndpoint.isEmpty()) {
					try { reply = request(normalize(localEndpoint), "POST", "/api/v1/messages", body, localToken); }
					catch (Exception ignored) { reply = relayRequest(body.put("type", "send")); }
				} else reply = relayRequest(body.put("type", "send"));
			} else reply = request(base, "POST", "/api/v1/messages", body, token);
			if (anywhere && reply.optString("jobId", "").length() > 0) reply = waitRemoteJob(reply.getString("jobId"));
			sessionId = reply.getString("sessionId"); getPreferences(MODE_PRIVATE).edit().putString("session", sessionId).apply(); ui(this::refresh);
		} catch (Exception error) { ui(() -> { setStatus("No se pudo enviar: " + error.getMessage()); refresh(); }); } finally { sendInFlight = false; } });
	}

	private void cancelTurn() {
		if (!appUnlocked || workspaceId.isEmpty() || sessionId.isEmpty()) { setStatus("No hay una tarea activa para detener."); return; }
		setStatus("Deteniendo la tarea…");
		io.execute(() -> { try {
			JSONObject reply = anywhere
				? relayRequest(new JSONObject().put("type", "cancel").put("workspaceId", workspaceId).put("sessionId", sessionId))
				: request(normalize(endpoint.getText().toString()), "POST", "/api/v1/cancel", new JSONObject().put("workspaceId", workspaceId).put("sessionId", sessionId), token);
			boolean cancelled = reply.optBoolean("cancelled", false);
			ui(() -> { setStatus(cancelled ? "Tarea detenida" : "No había una tarea activa"); refresh(); });
		} catch (Exception error) { ui(() -> setStatus("No se pudo detener: " + error.getMessage())); } });
	}

	private JSONObject waitExternalRun(String runId) throws Exception {
		long deadline = System.currentTimeMillis() + 24L * 60L * 60L * 1000L;
		while (System.currentTimeMillis() < deadline) {
			JSONObject status;
			if (anywhere) status = relayRequest(new JSONObject().put("type", "external-status").put("workspaceId", workspaceId).put("runId", runId)).optJSONObject("status");
			else status = request(normalize(endpoint.getText().toString()), "GET", "/api/v1/external?workspaceId=" + workspaceId + "&runId=" + runId, null, token);
			if (status == null) throw new IOException("El escritorio devolvió un estado de agente externo inválido.");
			String state = status.optString("status", "");
			if ("done".equals(state)) return new JSONObject().put("sessionId", status.optString("sessionId", sessionId));
			if ("error".equals(state) || "cancelled".equals(state)) throw new IOException(status.optString("error", "El agente externo terminó sin completar la tarea."));
			Thread.sleep(1800);
		}
		throw new IOException("El agente externo sigue trabajando. Abre el chat para consultar el progreso.");
	}

    private void capture() {
		if (!appUnlocked || captureInFlight) return;
		captureInFlight = true;
        final String base = normalize(endpoint.getText().toString()); setStatus("Tomando captura del escritorio…");
        io.execute(() -> { try {
            Bitmap image;
            if (anywhere) {
                try {
                    HttpURLConnection localConnection = connection(normalize(localEndpoint) + "/api/v1/screenshot", "GET", localToken);
                    try (InputStream in = localConnection.getInputStream()) { image = BitmapFactory.decodeStream(in); } finally { localConnection.disconnect(); }
                } catch (Exception ignored) {
                    String encoded = relayRequest(new JSONObject().put("type", "screenshot")).getString("image");
                    byte[] bytes = Base64.decode(encoded, Base64.DEFAULT); image = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                }
            } else {
                HttpURLConnection c = connection(base + "/api/v1/screenshot", "GET", token); try (InputStream in = c.getInputStream()) { image = BitmapFactory.decodeStream(in); } finally { c.disconnect(); }
            }
			if (image == null) throw new IOException("ChatGPT 2 no devolvió una imagen."); final Bitmap captured = image; ui(() -> { addScreenshot(captured); setStatus("Captura actualizada"); });
		} catch (Exception error) { ui(() -> setStatus("No se pudo capturar: " + error.getMessage())); } finally { captureInFlight = false; } });
	}

    private void openBrowserChooser() {
        if (!connected() || !appUnlocked) { setStatus("Desbloquea y conecta ChatGPT 2 para abrir el navegador."); return; }
        String[] choices = { "Navegador de la PC · sesión de ChatGPT 2", "Navegador en este teléfono · sesión independiente" };
        new AlertDialog.Builder(this).setTitle("Navegador integrado").setItems(choices, (dialog, which) -> {
            if (which == 0) openRemoteBrowser(); else openLocalBrowser();
        }).setNegativeButton("Cerrar", null).show();
    }

    /**
     * Opens a normal Android WebView. Its cookies stay inside this app's private WebView storage,
     * so a ChatGPT or Perplexity login made here never becomes a desktop credential or a QR secret.
     */
    private void openLocalBrowser() {
        final Dialog dialog = new Dialog(this);
        LinearLayout shell = browserShell();
        LinearLayout heading = row();
        TextView title = label("Navegador · teléfono", 17, TEXT); title.setTypeface(Typeface.DEFAULT, Typeface.BOLD); heading.addView(title, weight());
        Button close = quietButton("Cerrar"); close.setOnClickListener(v -> dialog.dismiss()); heading.addView(close);
        shell.addView(heading, fill());
        TextView note = label("La sesión de este navegador pertenece al teléfono. Para ver y controlar la sesión iniciada en ChatGPT 2, usa «Navegador de la PC».", 12, MUTED); note.setLineSpacing(dp(2), 1f); note.setPadding(0, dp(4), 0, dp(7)); shell.addView(note, fill());

        LinearLayout quick = row();
        Button chatGpt = quietButton("ChatGPT"); Button perplexity = quietButton("Perplexity"); Button back = quietButton("‹"); Button forward = quietButton("›"); Button reload = quietButton("↻");
        quick.addView(chatGpt); quick.addView(perplexity); quick.addView(back); quick.addView(forward); quick.addView(reload); shell.addView(quick, fill());

        LinearLayout addressRow = row();
        EditText address = input("https://chatgpt.com/"); address.setSingleLine(true); address.setText("https://chatgpt.com/"); addressRow.addView(address, weight());
        Button go = accentButton("Ir"); addressRow.addView(go); shell.addView(addressRow, fill());

        final WebView web = new WebView(this);
        configureWebView(web, address);
        shell.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        chatGpt.setOnClickListener(v -> navigateWebView(web, address, "https://chatgpt.com/"));
        perplexity.setOnClickListener(v -> navigateWebView(web, address, "https://www.perplexity.ai/"));
        back.setOnClickListener(v -> { if (web.canGoBack()) web.goBack(); });
        forward.setOnClickListener(v -> { if (web.canGoForward()) web.goForward(); });
        reload.setOnClickListener(v -> web.reload());
        go.setOnClickListener(v -> navigateWebView(web, address, address.getText().toString()));

        dialog.setContentView(shell);
        dialog.setOnKeyListener((d, keyCode, event) -> { if (keyCode == android.view.KeyEvent.KEYCODE_BACK && event.getAction() == android.view.KeyEvent.ACTION_UP && web.canGoBack()) { web.goBack(); return true; } return false; });
        dialog.setOnDismissListener(d -> { CookieManager.getInstance().flush(); web.onPause(); web.destroy(); });
        showFullScreen(dialog);
        web.loadUrl("https://chatgpt.com/");
    }

    private LinearLayout browserShell() {
        LinearLayout shell = new LinearLayout(this); shell.setOrientation(LinearLayout.VERTICAL); shell.setPadding(dp(12), dp(12), dp(12), dp(10)); shell.setBackgroundColor(BG); return shell;
    }

    private void configureWebView(WebView web, EditText address) {
        WebSettings settings = web.getSettings(); settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true); settings.setDatabaseEnabled(true); settings.setBuiltInZoomControls(false); settings.setDisplayZoomControls(false); settings.setSupportZoom(true); settings.setLoadsImagesAutomatically(true);
        CookieManager cookies = CookieManager.getInstance(); cookies.setAcceptCookie(true); if (android.os.Build.VERSION.SDK_INT >= 21) cookies.setAcceptThirdPartyCookies(web, true);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) { return !isBrowserUrl(url); }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return !isBrowserUrl(request.getUrl().toString()); }
            @Override public void onPageFinished(WebView view, String url) { address.setText(url); }
        });
        web.setWebChromeClient(new WebChromeClient());
    }

    private void navigateWebView(WebView web, EditText address, String raw) {
        String url = normalizeBrowserUrl(raw); if (url.isEmpty()) { setStatus("Escribe una dirección web válida (http o https)."); return; }
        address.setText(url); web.loadUrl(url);
    }

    private String normalizeBrowserUrl(String raw) {
        String value = raw == null ? "" : raw.trim(); if (value.isEmpty()) return "";
        if (!value.matches("(?i)^(?:https?://|about:blank$).*")) value = "https://" + value;
        return isBrowserUrl(value) ? value : "";
    }

    private boolean isBrowserUrl(String url) { return url != null && url.matches("(?i)^(?:https?://|about:blank$).*"); }

    private void showFullScreen(Dialog dialog) {
        dialog.show(); android.view.Window window = dialog.getWindow();
        if (window != null) { window.setBackgroundDrawable(card(BG, 0)); window.setLayout(-1, -1); window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE); }
    }

    /** Shows and controls the already-authenticated Chromium tab in the desktop ChatGPT 2 window. */
    private void openRemoteBrowser() {
        final Dialog dialog = new Dialog(this);
        remoteBrowserDialog = dialog; remotePages = new JSONArray(); remotePageId = ""; remoteBrowserBitmap = null;
        LinearLayout shell = browserShell();
        LinearLayout heading = row();
        TextView title = label("Navegador · ChatGPT 2 en la PC", 17, TEXT); title.setTypeface(Typeface.DEFAULT, Typeface.BOLD); heading.addView(title, weight());
        Button close = quietButton("Cerrar"); close.setOnClickListener(v -> dialog.dismiss()); heading.addView(close); shell.addView(heading, fill());
        TextView note = label("Se controla la pestaña visible de ChatGPT 2. Las páginas no compartidas se muestran sin contenido hasta que decidas compartirlas; las cookies y la sesión permanecen en la PC.", 12, MUTED); note.setLineSpacing(dp(2), 1f); note.setPadding(0, dp(4), 0, dp(7)); shell.addView(note, fill());

        LinearLayout tabs = row(); remotePagePicker = new Spinner(this); tabs.addView(remotePagePicker, weight()); Button refreshPages = quietButton("Actualizar"); refreshPages.setOnClickListener(v -> loadRemoteBrowserPages()); tabs.addView(refreshPages); shell.addView(tabs, fill());
        remotePageInfo = label("Cargando pestañas compartidas…", 12, MUTED); remotePageInfo.setMaxLines(2); remotePageInfo.setPadding(dp(4), dp(4), dp(4), dp(4)); shell.addView(remotePageInfo, fill());

        LinearLayout shareRow = row(); remoteShareButton = quietButton("Compartir pestaña"); remoteUnshareButton = quietButton("Dejar de compartir"); shareRow.addView(remoteShareButton); shareRow.addView(remoteUnshareButton); remoteBrowserStatus = label("", 11, MUTED); remoteBrowserStatus.setGravity(Gravity.CENTER_VERTICAL); shareRow.addView(remoteBrowserStatus, weight()); shell.addView(shareRow, fill());

        LinearLayout addressRow = row(); remoteBrowserAddress = input("https://chatgpt.com/"); remoteBrowserAddress.setSingleLine(true); addressRow.addView(remoteBrowserAddress, weight()); remoteBrowserGo = accentButton("Ir"); addressRow.addView(remoteBrowserGo); shell.addView(addressRow, fill());
        LinearLayout quick = row(); Button chatGpt = quietButton("ChatGPT"); Button perplexity = quietButton("Perplexity"); Button back = quietButton("‹"); Button forward = quietButton("›"); Button reload = quietButton("↻"); quick.addView(chatGpt); quick.addView(perplexity); quick.addView(back); quick.addView(forward); quick.addView(reload); shell.addView(quick, fill());

        remotePageImage = new ImageView(this); remotePageImage.setAdjustViewBounds(true); remotePageImage.setScaleType(ImageView.ScaleType.FIT_CENTER); remotePageImage.setMinimumHeight(dp(250)); remotePageImage.setBackground(card(SURFACE_RAISED, 12)); remotePageImage.setPadding(dp(2), dp(2), dp(2), dp(2)); shell.addView(remotePageImage, new LinearLayout.LayoutParams(-1, 0, 1));
        remotePageImage.setOnTouchListener((view, event) -> { if (event.getAction() == MotionEvent.ACTION_DOWN) { remoteTouchX = event.getX(); remoteTouchY = event.getY(); remoteTouchActive = true; return true; } if (event.getAction() == MotionEvent.ACTION_UP && remoteTouchActive) { remoteTouchActive = false; if (Math.hypot(event.getX() - remoteTouchX, event.getY() - remoteTouchY) < dp(20)) remoteBrowserTap(event.getX(), event.getY()); return true; } if (event.getAction() == MotionEvent.ACTION_CANCEL) remoteTouchActive = false; return true; });

        LinearLayout inputRow = row(); remoteBrowserInput = input("Texto para escribir en la página"); remoteBrowserInput.setSingleLine(true); inputRow.addView(remoteBrowserInput, weight()); Button type = quietButton("Escribir"); Button enter = accentButton("Enter"); inputRow.addView(type); inputRow.addView(enter); shell.addView(inputRow, fill());
        remoteShareButton.setOnClickListener(v -> shareRemotePage()); remoteUnshareButton.setOnClickListener(v -> unshareRemotePage());
        refreshPages.setOnClickListener(v -> loadRemoteBrowserPages()); chatGpt.setOnClickListener(v -> openRemoteBrowserUrl("https://chatgpt.com/")); perplexity.setOnClickListener(v -> openRemoteBrowserUrl("https://www.perplexity.ai/")); remoteBrowserGo.setOnClickListener(v -> openRemoteBrowserUrl(remoteBrowserAddress.getText().toString()));
        back.setOnClickListener(v -> executeRemoteBrowser("async page => { await page.goBack(); return { ok: true }; }", null, "Atrás")); forward.setOnClickListener(v -> executeRemoteBrowser("async page => { await page.goForward(); return { ok: true }; }", null, "Adelante")); reload.setOnClickListener(v -> executeRemoteBrowser("async page => { await page.reload(); return { ok: true }; }", null, "Recargando"));
        type.setOnClickListener(v -> { String value = remoteBrowserInput.getText().toString(); if (value.trim().isEmpty()) { setRemoteBrowserStatus("Escribe un texto primero."); return; } executeRemoteBrowser("async (page, text) => { await page.keyboard.type(String(text)); return { ok: true }; }", new JSONArray().put(value), "Texto escrito"); });
        enter.setOnClickListener(v -> executeRemoteBrowser("async page => { await page.keyboard.press('Enter'); return { ok: true }; }", null, "Enter enviado"));
        remotePagePicker.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener() { public void onNothingSelected(android.widget.AdapterView<?> parent) {} public void onItemSelected(android.widget.AdapterView<?> parent, View view, int position, long id) { selectRemotePage(position); } });
        dialog.setContentView(shell); dialog.setOnDismissListener(d -> { remoteBrowserDialog = null; remotePagePicker = null; remotePageImage = null; remoteBrowserStatus = null; remotePageInfo = null; remoteBrowserAddress = null; remoteBrowserInput = null; remoteBrowserBitmap = null; remotePageId = ""; });
        showFullScreen(dialog); loadRemoteBrowserPages();
    }

    private void loadRemoteBrowserPages() {
        if (remoteBrowserDialog == null || !remoteBrowserDialog.isShowing()) return;
        setRemoteBrowserStatus("Consultando pestañas…");
        try { remoteBrowserCall(new JSONObject().put("action", "list"), result -> {
            if (remoteBrowserDialog == null) return;
            JSONArray pages = result.optJSONArray("pages"); remotePages = pages == null ? new JSONArray() : pages;
            ArrayList<String> labels = new ArrayList<>();
            for (int i = 0; i < remotePages.length(); i++) { JSONObject page = remotePages.optJSONObject(i); if (page == null) continue; labels.add((page.optBoolean("shared", false) ? "● " : "○ ") + page.optString("title", "Nueva pestaña") + "\n" + page.optString("url", "")); }
            ArrayAdapter<String> adapter = new ArrayAdapter<>(this, android.R.layout.simple_spinner_item, labels); adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item); remotePagePicker.setAdapter(adapter);
            if (labels.isEmpty()) { remotePageId = ""; remoteBrowserBitmap = null; remotePageImage.setImageDrawable(null); remotePageInfo.setText("No hay pestañas del navegador de ChatGPT 2. Abre una desde la PC o pulsa ChatGPT/Perplexity."); updateRemoteBrowserButtons(false); setRemoteBrowserStatus("Sin pestañas"); }
            else { setRemoteBrowserStatus("Selecciona una pestaña compartida para controlarla."); }
        }); } catch (JSONException error) { setRemoteBrowserStatus("No se pudo consultar el navegador."); }
    }

    private void selectRemotePage(int position) {
        JSONObject page = remotePages.optJSONObject(position); if (page == null) return;
        remotePageId = page.optString("pageId", ""); boolean shared = page.optBoolean("shared", false); remoteBrowserAddress.setText(page.optString("url", "")); remotePageInfo.setText(page.optString("title", "Nueva pestaña") + "\n" + page.optString("url", "")); updateRemoteBrowserButtons(shared);
        if (shared) requestRemoteBrowserScreenshot(); else { remoteBrowserBitmap = null; remotePageImage.setImageDrawable(null); setRemoteBrowserStatus("Comparte esta pestaña para poder verla y controlarla desde el teléfono."); }
    }

    private void updateRemoteBrowserButtons(boolean shared) { if (remoteShareButton != null) remoteShareButton.setEnabled(!shared); if (remoteUnshareButton != null) remoteUnshareButton.setEnabled(shared); }

    private void shareRemotePage() { if (remotePageId.isEmpty()) { setRemoteBrowserStatus("Selecciona una pestaña primero."); return; } try { remoteBrowserCall(new JSONObject().put("action", "share").put("pageId", remotePageId), result -> { setRemoteBrowserStatus("Pestaña compartida"); loadRemoteBrowserPages(); }); } catch (JSONException ignored) {} }
    private void unshareRemotePage() { if (remotePageId.isEmpty()) { setRemoteBrowserStatus("Selecciona una pestaña primero."); return; } try { remoteBrowserCall(new JSONObject().put("action", "unshare").put("pageId", remotePageId), result -> { setRemoteBrowserStatus("Pestaña ya no compartida"); loadRemoteBrowserPages(); }); } catch (JSONException ignored) {} }

    private void openRemoteBrowserUrl(String raw) { String url = normalizeBrowserUrl(raw); if (url.isEmpty()) { setRemoteBrowserStatus("La dirección debe usar http o https."); return; } try { remoteBrowserCall(new JSONObject().put("action", "open").put("url", url), result -> { remotePageId = result.optString("pageId", ""); remoteBrowserAddress.setText(result.optString("url", url)); setRemoteBrowserStatus("Pestaña abierta en la sesión de la PC"); loadRemoteBrowserPages(); requestRemoteBrowserScreenshot(); }); } catch (JSONException ignored) {} }

    private void requestRemoteBrowserScreenshot() { if (remotePageId.isEmpty()) return; try { remoteBrowserCall(new JSONObject().put("action", "screenshot").put("pageId", remotePageId), result -> { String encoded = result.optString("base64", ""); try { byte[] bytes = Base64.decode(encoded, Base64.DEFAULT); remoteBrowserBitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length); if (remoteBrowserBitmap == null) throw new IOException("imagen inválida"); remotePageImage.setImageBitmap(remoteBrowserBitmap); setRemoteBrowserStatus("Pestaña sincronizada"); } catch (Exception error) { setRemoteBrowserStatus("La pestaña respondió, pero la captura no se pudo mostrar."); } }); } catch (JSONException ignored) {} }

    private void remoteBrowserTap(float viewX, float viewY) {
        if (remoteBrowserBitmap == null || remotePageId.isEmpty() || remotePageImage == null) return;
        float contentWidth = Math.max(1, remotePageImage.getWidth() - remotePageImage.getPaddingLeft() - remotePageImage.getPaddingRight()); float contentHeight = Math.max(1, remotePageImage.getHeight() - remotePageImage.getPaddingTop() - remotePageImage.getPaddingBottom()); float scale = Math.min(contentWidth / (float) remoteBrowserBitmap.getWidth(), contentHeight / (float) remoteBrowserBitmap.getHeight()); float displayedWidth = remoteBrowserBitmap.getWidth() * scale; float displayedHeight = remoteBrowserBitmap.getHeight() * scale; float left = (remotePageImage.getWidth() - displayedWidth) / 2f; float top = (remotePageImage.getHeight() - displayedHeight) / 2f; float x = (viewX - left) / scale; float y = (viewY - top) / scale;
        if (x < 0 || y < 0 || x > remoteBrowserBitmap.getWidth() || y > remoteBrowserBitmap.getHeight()) return;
        try { JSONObject point = new JSONObject().put("x", x).put("y", y); executeRemoteBrowser("async (page, point) => { await page.mouse.click(Number(point.x), Number(point.y)); return { ok: true }; }", new JSONArray().put(point), "Clic enviado"); } catch (JSONException ignored) {}
    }

    private void executeRemoteBrowser(String code, JSONArray args, String message) {
        if (remotePageId.isEmpty()) { setRemoteBrowserStatus("Selecciona y comparte una pestaña primero."); return; }
        try { JSONObject command = new JSONObject().put("action", "execute").put("pageId", remotePageId).put("code", code); if (args != null) command.put("args", args); remoteBrowserCall(command, result -> { setRemoteBrowserStatus(message); requestRemoteBrowserScreenshot(); }); } catch (JSONException ignored) {}
    }

    private void setRemoteBrowserStatus(String message) { if (remoteBrowserStatus != null) remoteBrowserStatus.setText(message); }

    private interface BrowserCallback { void onResult(JSONObject result); }

    private void remoteBrowserCall(JSONObject command, BrowserCallback callback) {
        io.execute(() -> { try { JSONObject result = browserRequest(command); ui(() -> { if (remoteBrowserDialog != null && remoteBrowserDialog.isShowing()) callback.onResult(result); }); } catch (Exception error) { ui(() -> setRemoteBrowserStatus("Navegador: " + error.getMessage())); } });
    }

    private JSONObject browserRequest(JSONObject body) throws Exception {
        JSONObject reply;
        if (anywhere) {
            if (!localToken.isEmpty() && !localEndpoint.isEmpty()) {
                try { reply = request(normalize(localEndpoint), "POST", "/api/v1/browser", body, localToken); }
                catch (Exception ignored) { reply = relayRequest(new JSONObject(body.toString()).put("type", "browser")); }
            } else reply = relayRequest(new JSONObject(body.toString()).put("type", "browser"));
        } else reply = request(normalize(endpoint.getText().toString()), "POST", "/api/v1/browser", body, token);
        Object data = reply.opt("data"); return data instanceof JSONObject ? (JSONObject) data : reply;
    }

    /** Keep a local snapshot so switching projects is instant and does not require a new QR. */
    private void rememberWorkspaces(JSONArray spaces) {
        try { availableWorkspaces = spaces == null ? new JSONArray() : new JSONArray(spaces.toString()); }
        catch (JSONException ignored) { availableWorkspaces = new JSONArray(); }
    }

    private void chooseProject() {
        if (!connected() || !appUnlocked) { setStatus("Desbloquea y conecta ChatGPT 2 para ver sus proyectos."); return; }
        if (availableWorkspaces.length() == 0) { setStatus("Actualizando proyectos…"); refresh(); return; }
        LinearLayout list = new LinearLayout(this); list.setOrientation(LinearLayout.VERTICAL); list.setPadding(dp(8), 0, dp(8), 0);
        for (int i = 0; i < availableWorkspaces.length(); i++) {
            JSONObject space = availableWorkspaces.optJSONObject(i); if (space == null) continue;
            String name = space.optString("name", "ChatGPT 2"); String root = space.optString("root", "");
            Button item = quietButton(name + (root.isEmpty() ? "" : "\n" + root)); item.setTextSize(13); item.setGravity(Gravity.START | Gravity.CENTER_VERTICAL); item.setPadding(dp(13), dp(8), dp(13), dp(8)); item.setMinHeight(dp(58));
            item.setOnClickListener(v -> selectWorkspace(space));
            LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(-1, -2); layout.setMargins(0, dp(3), 0, dp(3)); list.addView(item, layout);
        }
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true); scroll.addView(list, new ScrollView.LayoutParams(-1, -2));
        new AlertDialog.Builder(this).setTitle("Proyectos abiertos").setMessage("Elige el proyecto de ChatGPT 2 que quieres controlar.").setView(scroll).setNegativeButton("Cerrar", null).show();
    }

    private void selectWorkspace(JSONObject space) {
        if (space == null) return;
        try {
            workspaceId = space.getString("id"); workspaceName = space.optString("name", "ChatGPT 2"); sessionId = latestSession(space);
            getPreferences(MODE_PRIVATE).edit().putString("workspace", workspaceId).putString("workspaceName", workspaceName).putString("session", sessionId).apply();
            showChat(); setStatus("Proyecto seleccionado · sincronizando"); refresh();
        } catch (JSONException error) { setStatus("No se pudo seleccionar el proyecto."); }
    }

    private void showControls() {
        if (!connected() || !appUnlocked) { setStatus("Desbloquea y conecta ChatGPT 2 para usar sus controles."); return; }
        String title = workspaceName.isEmpty() ? "ChatGPT 2 Remote" : workspaceName;
	String[] actions = { "Cambiar proyecto", "Cambiar conversación", "Nueva conversación", "Actualizar chat", "Detener tarea actual", "Capturar escritorio", "Desemparejar teléfono" };
        new AlertDialog.Builder(this).setTitle(title).setItems(actions, (dialog, which) -> {
            if (which == 0) chooseProject();
            else if (which == 1) chooseSession();
            else if (which == 2) startNewSession();
            else if (which == 3) refresh();
			else if (which == 4) cancelTurn();
			else if (which == 5) capture();
			else if (which == 6) clearPairing();
        }).setNegativeButton("Cerrar", null).show();
    }

    private void chooseSession() {
        JSONObject current = null;
        for (int i = 0; i < availableWorkspaces.length(); i++) { JSONObject candidate = availableWorkspaces.optJSONObject(i); if (candidate != null && workspaceId.equals(candidate.optString("id"))) { current = candidate; break; } }
        JSONArray sessions = current == null ? null : current.optJSONArray("sessions");
        if (sessions == null || sessions.length() == 0) { setStatus("Este proyecto todavía no tiene conversaciones guardadas."); return; }
        LinearLayout list = new LinearLayout(this); list.setOrientation(LinearLayout.VERTICAL); list.setPadding(dp(8), 0, dp(8), 0);
        for (int i = 0; i < sessions.length(); i++) {
            JSONObject session = sessions.optJSONObject(i); if (session == null) continue;
            String id = session.optString("id", ""); String title = session.optString("title", "Conversación " + (i + 1)); String state = session.optString("status", "");
            Button item = quietButton(title + (state.isEmpty() ? "" : "\n" + state)); item.setTextSize(13); item.setGravity(Gravity.START | Gravity.CENTER_VERTICAL); item.setPadding(dp(13), dp(8), dp(13), dp(8)); item.setMinHeight(dp(54));
            if (id.equals(sessionId)) item.setText("✓  " + title + (state.isEmpty() ? "" : "\n" + state));
            item.setOnClickListener(v -> { sessionId = id; getPreferences(MODE_PRIVATE).edit().putString("session", sessionId).apply(); showChat(); setStatus("Conversación seleccionada · sincronizando"); refresh(); });
            LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(-1, -2); layout.setMargins(0, dp(3), 0, dp(3)); list.addView(item, layout);
        }
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true); scroll.addView(list, new ScrollView.LayoutParams(-1, -2));
        new AlertDialog.Builder(this).setTitle("Conversaciones de " + workspaceName).setView(scroll).setNegativeButton("Cerrar", null).show();
    }

    private void startNewSession() {
        sessionId = ""; getPreferences(MODE_PRIVATE).edit().remove("session").apply(); showWelcome(); setStatus("Nueva conversación lista"); composer.requestFocus();
    }

    private void clearPairing() { token = ""; localToken = ""; localEndpoint = ""; workspaceId = ""; workspaceName = ""; sessionId = ""; availableWorkspaces = new JSONArray(); anywhere = false; relayInstallation = ""; relayKey = ""; relayEncryptionKey = ""; relayDeviceToken = ""; removeSecret("token"); removeSecret("localToken"); removeSecret("relayKey"); removeSecret("relayEncryptionKey"); removeSecret("relayDeviceToken"); getPreferences(MODE_PRIVATE).edit().remove("endpoint").remove("localEndpoint").remove("workspace").remove("workspaceName").remove("session").remove("remoteMode").remove("relayInstallation").apply(); showPairing(); }

    private void renderMessages(JSONArray entries) { messages.removeAllViews(); if (entries == null || entries.length() == 0) { showWelcome(); return; } for (int i = 0; i < entries.length(); i++) { JSONObject entry = entries.optJSONObject(i); if (entry == null) continue; String role = entry.optString("role", "assistant"); if ("tool".equals(role) || "system".equals(role)) continue; String text = messageText(entry); if (!text.trim().isEmpty()) addBubble(role, text.trim()); } chatScroll.post(() -> chatScroll.fullScroll(View.FOCUS_DOWN)); }
    private void showWelcome() { messages.removeAllViews(); addBubble("assistant", "Hola, soy ChatGPT 2. Puedo continuar el trabajo de tu escritorio desde aquí."); }

    private void addBubble(String role, String text) {
        boolean user = "user".equals(role); LinearLayout row = new LinearLayout(this); row.setOrientation(LinearLayout.VERTICAL); row.setGravity(user ? Gravity.END : Gravity.START); row.setPadding(0, dp(7), 0, dp(7));
        TextView author = label(user ? "TÚ" : "✦  CHATGPT 2", 10, user ? MUTED : AMBER); author.setTypeface(Typeface.DEFAULT, Typeface.BOLD); author.setPadding(dp(4), 0, dp(4), dp(4)); row.addView(author);
        TextView bubble = label(text, 15, TEXT); bubble.setLineSpacing(dp(3), 1f); bubble.setTextIsSelectable(true); bubble.setPadding(dp(12), dp(10), dp(12), dp(10)); bubble.setMaxWidth(dp(340)); bubble.setBackground(card(user ? Color.rgb(22, 78, 66) : SURFACE_RAISED, 14)); row.addView(bubble);
        messages.addView(row, fill());
    }

    private void addScreenshot(Bitmap image) {
        LinearLayout row = new LinearLayout(this); row.setOrientation(LinearLayout.VERTICAL); row.setPadding(0, dp(9), 0, dp(9)); TextView title = label("CAPTURA DEL ESCRITORIO", 10, AMBER); title.setTypeface(Typeface.DEFAULT, Typeface.BOLD); title.setPadding(dp(4), 0, 0, dp(5)); row.addView(title);
        ImageView preview = new ImageView(this); preview.setImageBitmap(image); preview.setAdjustViewBounds(true); preview.setBackground(card(SURFACE_RAISED, 12)); preview.setPadding(dp(2), dp(2), dp(2), dp(2)); row.addView(preview, fill()); messages.addView(row, fill()); chatScroll.post(() -> chatScroll.fullScroll(View.FOCUS_DOWN));
    }

    private String messageText(JSONObject entry) { JSONObject message = entry.optJSONObject("message"); return message == null ? "" : extract(message.opt("parts")); }
    /** The companion is a chat client, not a debugging console: reveal only regular text parts. */
    private String extract(Object node) { if (node instanceof JSONObject) { JSONObject object = (JSONObject) node; return "text".equals(object.optString("type")) ? object.optString("text") : ""; } if (node instanceof JSONArray) { StringBuilder out = new StringBuilder(); JSONArray array = (JSONArray) node; for (int i = 0; i < array.length(); i++) { String text = extract(array.opt(i)); if (!text.isEmpty()) { if (out.length() > 0) out.append("\n"); out.append(text); } } return out.toString(); } return ""; }
    private void applyPairingPayload(String payload) {
        String[] fields = payload.trim().split("\\|", 4);
        if (fields.length == 3 && "F1".equals(fields[0])) { endpoint.setText(fields[1]); pairingCode.setText(fields[2]); manualFields.setVisibility(View.VISIBLE); pair(); return; }
        String[] encryptedFields = payload.trim().split("\\|", 5);
		if (payload.startsWith("F4|")) { pairHybrid(payload); return; }
        if (encryptedFields.length == 5 && "F3".equals(encryptedFields[0]) && encryptedFields[1].startsWith("https://") && encryptedFields[2].length() >= 32 && encryptedFields[3].length() >= 43 && encryptedFields[4].length() >= 43) {
            pairAnywhere(encryptedFields[1], encryptedFields[2], encryptedFields[3], encryptedFields[4]); return;
        }
        setStatus("Ese QR no pertenece a ChatGPT 2 Remote.");
    }

    @Override protected void onActivityResult(int request, int result, Intent data) { super.onActivityResult(request, result, data); if (request == PICK_FILES) { if (fileCallback != null) { fileCallback.onReceiveValue(result == RESULT_OK ? WebChromeClient.FileChooserParams.parseResult(result, data) : null); fileCallback = null; } return; } if (request == SCAN_QR && result == RESULT_OK && data != null) applyPairingPayload(data.getStringExtra(QrScannerActivity.RESULT_PAYLOAD)); if (request == UNLOCK_CHAT) { unlockInFlight = false; main.removeCallbacks(unlockWhenReady); if (result == RESULT_OK) { appUnlocked = true; unlockRetrySuppressed = false; showChat(); setStatus("Canal seguro desbloqueado"); refresh(); } else { appUnlocked = false; unlockRetrySuppressed = true; showPairing(); setStatus("Desbloquea el teléfono para abrir ChatGPT 2 Remote. Bloquea y desbloquea la pantalla para reintentar."); } } }
    private JSONObject request(String base, String method, String path, JSONObject body, String bearer) throws Exception { HttpURLConnection c = connection(base + path, method, bearer); if (body != null) { c.setDoOutput(true); byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8); c.setFixedLengthStreamingMode(bytes.length); try (OutputStream out = c.getOutputStream()) { out.write(bytes); } } int code = c.getResponseCode(); InputStream stream = code >= 400 ? c.getErrorStream() : c.getInputStream(); String text = read(stream); c.disconnect(); JSONObject result = new JSONObject(text.isEmpty() ? "{}" : text); if (code >= 400) throw new IOException(result.optString("error", "HTTP " + code)); return result; }
	private JSONObject relayRequest(JSONObject command) throws Exception {
		if (!anywhere || relayInstallation.isEmpty() || relayEncryptionKey.isEmpty() || relayDeviceToken.isEmpty()) throw new IOException("El acceso remoto no está configurado.");
        String id = UUID.randomUUID().toString();
		relayPost("/v3/command?installation=" + relayInstallation, new JSONObject().put("id", id).put("body", encryptRelay(command)));
        long deadline = System.currentTimeMillis() + 25_000;
		while (System.currentTimeMillis() < deadline) {
			JSONObject cached = pendingRelayResponses.remove(id);
			if (cached != null) {
				if (!cached.optBoolean("ok", false)) throw new IOException(cached.optString("error", "ChatGPT 2 no pudo completar la orden."));
				return cached;
			}
            JSONObject reply = relayPost("/v3/responses?installation=" + relayInstallation, new JSONObject()); JSONArray entries = reply.optJSONArray("messages");
				if (entries != null) for (int i = 0; i < entries.length(); i++) {
					JSONObject envelope = entries.optJSONObject(i); if (envelope == null) continue;
					String responseId = envelope.optString("id", ""); if (responseId.isEmpty()) continue;
					JSONObject body = decryptRelay(envelope.optJSONObject("body"));
					if (id.equals(responseId)) {
						if (!body.optBoolean("ok", false)) throw new IOException(body.optString("error", "ChatGPT 2 no pudo completar la orden."));
						return body;
					}
					// The relay returns a batch. Preserve responses belonging to another command
					// so concurrent sends cannot make each other wait until timeout.
					if (pendingRelayResponses.size() < 16) pendingRelayResponses.put(responseId, body);
				}
            Thread.sleep(300);
        }
		throw new IOException("El escritorio no respondió. Comprueba que ChatGPT 2 sigue abierto.");
	}
	private JSONObject waitRemoteJob(String jobId) throws Exception {
		long deadline = System.currentTimeMillis() + 24L * 60L * 60L * 1000L;
		while (System.currentTimeMillis() < deadline) {
			JSONObject envelope = relayRequest(new JSONObject().put("type", "job").put("jobId", jobId));
			JSONObject status = envelope.optJSONObject("status");
			if (status == null) throw new IOException("El escritorio devolvió un estado de tarea inválido.");
			String state = status.optString("status", "");
			if ("done".equals(state)) {
				return new JSONObject().put("sessionId", status.optString("sessionId", sessionId)).put("result", status.opt("result"));
			}
			if ("error".equals(state)) throw new IOException(status.optString("error", "ChatGPT 2 no pudo completar la tarea remota."));
			Thread.sleep(2500);
		}
		throw new IOException("La tarea remota sigue ejecutándose. Abre el chat para ver su progreso.");
	}
	private String relayPair() throws Exception { JSONObject reply = relayPairPost("/v3/pair?installation=" + relayInstallation, new JSONObject().put("deviceName", android.os.Build.MODEL).put("platform", "android")); String pairedToken = reply.optString("token", ""); if (pairedToken.length() < 43) throw new IOException("El relay no devolvió una credencial válida."); return pairedToken; }
    private JSONObject relayPost(String path, JSONObject body) throws Exception { HttpURLConnection c = relayConnection(normalize(endpoint.getText().toString()) + path); return postJson(c, body); }
    private JSONObject relayPairPost(String path, JSONObject body) throws Exception { HttpURLConnection c = pairingConnection(normalize(endpoint.getText().toString()) + path); return postJson(c, body); }
    private JSONObject postJson(HttpURLConnection c, JSONObject body) throws Exception { c.setDoOutput(true); byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8); c.setFixedLengthStreamingMode(bytes.length); try (OutputStream out = c.getOutputStream()) { out.write(bytes); } int code = c.getResponseCode(); InputStream stream = code >= 400 ? c.getErrorStream() : c.getInputStream(); String text = read(stream); c.disconnect(); JSONObject result = new JSONObject(text.isEmpty() ? "{}" : text); if (code >= 400) throw new IOException(result.optString("error", "HTTP " + code)); return result; }
    private HttpURLConnection connection(String address, String method, String bearer) throws Exception { validateEndpoint(address, false); HttpURLConnection c = (HttpURLConnection) new URL(address).openConnection(); c.setInstanceFollowRedirects(false); c.setRequestMethod(method); c.setConnectTimeout(8000); c.setReadTimeout(180000); c.setRequestProperty("Content-Type", "application/json"); if (!bearer.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + bearer); return c; }
    private HttpURLConnection relayConnection(String address) throws Exception { HttpURLConnection c = connection(address, "POST", ""); c.setConnectTimeout(10000); c.setReadTimeout(30000); c.setRequestProperty("X-Forja-Device", "android"); c.setRequestProperty("X-Forja-Device-Token", relayDeviceToken); return c; }
    private HttpURLConnection pairingConnection(String address) throws Exception { HttpURLConnection c = connection(address, "POST", ""); c.setConnectTimeout(10000); c.setReadTimeout(30000); c.setRequestProperty("X-Forja-Device", "android"); c.setRequestProperty("X-Forja-Pairing-Key", relayKey); return c; }
	private JSONObject encryptRelay(JSONObject body) throws Exception { byte[] iv = new byte[12]; new SecureRandom().nextBytes(iv); Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(Base64.decode(relayEncryptionKey, Base64.URL_SAFE | Base64.NO_WRAP), "AES"), new GCMParameterSpec(128, iv)); cipher.updateAAD(relayInstallation.getBytes(StandardCharsets.UTF_8)); byte[] ciphertext = cipher.doFinal(body.toString().getBytes(StandardCharsets.UTF_8)); return new JSONObject().put("iv", Base64.encodeToString(iv, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING)).put("ciphertext", Base64.encodeToString(ciphertext, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING)); }
	private JSONObject decryptRelay(JSONObject packet) throws Exception { if (packet == null) throw new IOException("Respuesta remota inválida."); String iv = packet.optString("iv", ""), ciphertext = packet.optString("ciphertext", ""); if (iv.length() != 16 || ciphertext.length() < 24) throw new IOException("Respuesta remota inválida."); Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(Base64.decode(relayEncryptionKey, Base64.URL_SAFE | Base64.NO_WRAP), "AES"), new GCMParameterSpec(128, Base64.decode(iv, Base64.URL_SAFE | Base64.NO_WRAP))); cipher.updateAAD(relayInstallation.getBytes(StandardCharsets.UTF_8)); return new JSONObject(new String(cipher.doFinal(Base64.decode(ciphertext, Base64.URL_SAFE | Base64.NO_WRAP)), StandardCharsets.UTF_8)); }
	private String latestSession(JSONObject space) throws JSONException { JSONArray sessions = space.optJSONArray("sessions"); return sessions != null && sessions.length() > 0 ? sessions.getJSONObject(0).getString("id") : ""; }
	/** Secrets are encrypted with an Android Keystore AES key; plaintext values are migrated once. */
	private SecretKey secretKey() throws Exception {
		KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
		if (!store.containsAlias(KEYSTORE_ALIAS)) {
			KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
			generator.init(new KeyGenParameterSpec.Builder(KEYSTORE_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
				.setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
			generator.generateKey();
		}
		return ((KeyStore.SecretKeyEntry) store.getEntry(KEYSTORE_ALIAS, null)).getSecretKey();
	}
	/**
	 * Los secretos se guardan cifrados con una llave del Android Keystore Y con una copia cifrada con una llave aleatoria en la
	 * carpeta privada de la app. Algunos teléfonos (Huawei/HarmonyOS...) borran las llaves del Keystore al cerrar o actualizar la app
	 * y el emparejamiento se perdía; si la llave del Keystore falla se usa la copia y se regraba la del Keystore.
	 */
	private SecretKey fileKey() throws Exception {
		File file = new File(getFilesDir(), "pairing.key");
		byte[] raw;
		if (file.exists() && file.length() == 32) { raw = new byte[32]; try (FileInputStream in = new FileInputStream(file)) { int off = 0; while (off < 32) { int n = in.read(raw, off, 32 - off); if (n < 0) break; off += n; } } }
		else { raw = new byte[32]; new SecureRandom().nextBytes(raw); try (FileOutputStream out = new FileOutputStream(file)) { out.write(raw); } file.setReadable(false, false); file.setReadable(true, true); file.setWritable(false, false); file.setWritable(true, true); }
		return new SecretKeySpec(raw, "AES");
	}
	private String sealWith(SecretKey key, String value) throws Exception {
		byte[] iv = new byte[12]; new SecureRandom().nextBytes(iv);
		Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(128, iv));
		return Base64.encodeToString(iv, Base64.URL_SAFE | Base64.NO_WRAP) + "." + Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.URL_SAFE | Base64.NO_WRAP);
	}
	private String openWith(SecretKey key, String stored) throws Exception {
		String[] fields = stored.split("\\.", 2); if (fields.length != 2) throw new IOException("formato");
		Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
		cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, Base64.decode(fields[0], Base64.URL_SAFE | Base64.NO_WRAP)));
		return new String(cipher.doFinal(Base64.decode(fields[1], Base64.URL_SAFE | Base64.NO_WRAP)), StandardCharsets.UTF_8);
	}
	private String loadSecret(String name) {
		SharedPreferences prefs = getPreferences(MODE_PRIVATE);
		String stored = prefs.getString("secret." + name, ""), backup = prefs.getString("fsecret." + name, "");
		if (!stored.isEmpty()) { try { return openWith(secretKey(), stored); } catch (Exception ignored) { /* llave del Keystore perdida: se prueba la copia */ } }
		if (!backup.isEmpty()) {
			try { String value = openWith(fileKey(), backup); saveSecret(name, value); return value; } catch (Exception ignored) { return ""; }
		}
		// Migrate credentials written by older builds, then remove the plaintext value.
		try {
			String legacy = prefs.getString(name, "");
			if (!legacy.isEmpty()) { saveSecret(name, legacy); prefs.edit().remove(name).apply(); }
			return legacy;
		} catch (Exception ignored) { return ""; }
	}
	private void saveSecret(String name, String value) {
		if (value == null || value.isEmpty()) { removeSecret(name); return; }
		SharedPreferences.Editor edit = getPreferences(MODE_PRIVATE).edit().remove(name);
		try { edit.putString("secret." + name, sealWith(secretKey(), value)); } catch (Exception ignored) { /* sin Keystore: queda la copia de la carpeta privada */ }
		try { edit.putString("fsecret." + name, sealWith(fileKey(), value)); } catch (Exception ignored) { }
		edit.apply();
	}
	private void removeSecret(String name) { getPreferences(MODE_PRIVATE).edit().remove("secret." + name).remove("fsecret." + name).remove(name).apply(); }
	private String read(InputStream in) throws IOException { if (in == null) return ""; ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] bytes = new byte[4096]; for (int n; (n = in.read(bytes)) >= 0;) { if (out.size() + n > MAX_RESPONSE_BYTES) throw new IOException("La respuesta de ChatGPT 2 es demasiado grande."); out.write(bytes, 0, n); } return out.toString("UTF-8"); }
    private boolean connected() { return anywhere ? (!relayInstallation.isEmpty() && !relayEncryptionKey.isEmpty() && !relayDeviceToken.isEmpty()) || !localToken.isEmpty() : !token.isEmpty(); }
    /**
     * Pairing may use cleartext only for a directly reachable loopback/LAN desktop.
     * Public endpoints and relays must use TLS so pairing codes and bearer tokens are
     * never sent over an arbitrary HTTP host. Redirects are disabled in connection().
     */
    private String normalize(String address) {
        String value = address == null ? "" : address.trim();
        if (value.isEmpty()) return "";
        if (!value.matches("(?i)^https?://.*")) value = "http://" + value;
        value = value.replaceAll("/+$", "");
        try { validateEndpoint(value, true); return value; } catch (IOException ignored) { return ""; }
    }

    private void validateEndpoint(String address, boolean base) throws IOException {
        try {
            URI uri = new URI(address);
            String scheme = uri.getScheme();
            String host = uri.getHost();
            if (uri.isOpaque() || scheme == null || host == null || uri.getRawUserInfo() != null || uri.getRawFragment() != null || (base && uri.getRawQuery() != null)) {
                throw new IOException("La dirección de ChatGPT 2 no es válida.");
            }
            if (!("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))) {
                throw new IOException("La conexión debe usar HTTP o HTTPS.");
            }
            if ("http".equalsIgnoreCase(scheme) && !isPrivateHttpHost(host)) {
                throw new IOException("HTTP solo está permitido para una dirección local o privada; usa HTTPS para un relay.");
            }
        } catch (URISyntaxException error) {
            throw new IOException("La dirección de ChatGPT 2 no es válida.", error);
        }
    }

    private boolean isPrivateHttpHost(String rawHost) {
        String host = rawHost == null ? "" : rawHost.trim().toLowerCase(Locale.ROOT);
        if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length() - 1);
        if ("localhost".equals(host) || host.endsWith(".localhost")) return true;
        if (host.indexOf(':') >= 0) {
            try {
                InetAddress address = InetAddress.getByName(host);
                return address.isLoopbackAddress() || address.isLinkLocalAddress() || address.isSiteLocalAddress() || host.startsWith("fc") || host.startsWith("fd");
            } catch (Exception ignored) { return false; }
        }
        String[] octets = host.split("\\.", -1);
        if (octets.length != 4) return false;
        try {
            int first = Integer.parseInt(octets[0]);
            int second = Integer.parseInt(octets[1]);
            for (String octet : octets) if (octet.isEmpty() || Integer.parseInt(octet) < 0 || Integer.parseInt(octet) > 255) return false;
            return first == 10 || first == 127 || (first == 172 && second >= 16 && second <= 31) || (first == 192 && second == 168) || (first == 169 && second == 254);
        } catch (NumberFormatException ignored) { return false; }
    }
    private void setStatus(String text) { status.setText(text); }
    private void ui(Runnable run) { main.post(run); }
    private TextView label(String text, int size, int color) { TextView view = new TextView(this); view.setText(text); view.setTextSize(size); view.setTextColor(color); return view; }
    private EditText input(String hint) { EditText view = new EditText(this); view.setHint(hint); view.setHintTextColor(Color.rgb(132, 123, 114)); view.setTextColor(TEXT); view.setTextSize(14); view.setSingleLine(false); view.setPadding(dp(10), dp(8), dp(10), dp(8)); view.setBackground(card(Color.rgb(29, 26, 23), 9)); LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(-1, -2); layout.setMargins(0, dp(4), 0, dp(4)); view.setLayoutParams(layout); return view; }
    private Button accentButton(String text) { Button view = button(text); view.setTextColor(Color.WHITE); view.setBackground(card(AMBER, 9)); return view; }
    private Button quietButton(String text) { Button view = button(text); view.setTextColor(TEXT); view.setBackground(card(Color.rgb(62, 55, 49), 9)); return view; }
    private Button button(String text) { Button view = new Button(this); view.setText(text); view.setTextSize(12); view.setAllCaps(false); view.setMinHeight(0); view.setMinimumHeight(0); LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(-2, dp(38)); layout.setMargins(dp(5), 0, 0, 0); view.setLayoutParams(layout); return view; }
    private GradientDrawable card(int color, int radius) { GradientDrawable shape = new GradientDrawable(); shape.setColor(color); shape.setCornerRadius(dp(radius)); return shape; }
    private LinearLayout row() { LinearLayout view = new LinearLayout(this); view.setOrientation(LinearLayout.HORIZONTAL); view.setGravity(Gravity.CENTER_VERTICAL); return view; }
    private LinearLayout.LayoutParams fill() { return new LinearLayout.LayoutParams(-1, -2); }
    private LinearLayout.LayoutParams weight() { return new LinearLayout.LayoutParams(0, -2, 1); }
    private int dp(int value) { return (int) (value * getResources().getDisplayMetrics().density + .5f); }
}
