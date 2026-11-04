package net.koma.reader

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.JsResult
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject
import android.widget.Toast
import androidx.webkit.WebViewAssetLoader
import java.io.File
import java.io.FileInputStream
import java.io.IOException

/**
 * KOMA Локальная: только библиотека и читалка, без единого сетевого пути.
 *
 * Почему так:
 *  • читалка — один самодостаточный html (модели, словарь, WASM внутри), ей не
 *    нужен сервер; интернет в сборке нужен РОВНО для голосов Edge, которые
 *    человек включает сам (⚙ → Голос и чтение → Онлайн-голос);
 *  • адрес страницы постоянный — https://appassets.androidplatform.net/web/koma-web.html.
 *    Это важно: IndexedDB, где лежат модели, книги и настройки, привязан к
 *    источнику, поэтому обновление файла НЕ стирает библиотеку;
 *  • распознавание — ОДИН движок: локальные модели ONNX в фоне (как в первой
 *    читалке Yomikai). Облачного движка Lens нет: он не читал страницу сам, а
 *    требовал открыть сайт в отдельном окне и перенести текст руками.
 */
class MainActivity : android.app.Activity() {

    private lateinit var web: WebView
    private lateinit var speech: KomaSpeechBridge
    private lateinit var plugins: KomaPluginsBridge
    // Интерфейс чтения — нативный: полоса под страницей, а не HTML поверх ленты.
    private lateinit var ui: KomaUiBridge
    private val readEngine = KomaReadBridge()
    private lateinit var ocrEngine: OcrEngine
    private lateinit var ocr: KomaOcrBridge
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val appVersion: String by lazy {
        try { packageManager.getPackageInfo(packageName, 0).versionName ?: "1.0" } catch (e: Exception) { "1.0" }
    }

    // Выбор файлов моделей: три файла сразу, через системный «Файлы».
    private val RC_FILES = 1001
    // Отдельный выбор — для НАТИВНЫХ моделей (они копируются в приложение).
    private val RC_MODELS = 1002
    // И ещё один — для плагинов (.json): их кладут в приложение из «Файлов».
    private val RC_PLUGIN = 1003

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Отладка WebView по adb: нужна живой студии в GitHub (эмулятор на раннере
        // управляет страницей через DevTools). Снаружи это недоступно: сокет
        // `webview_devtools_remote` открыт только локально для adb, сеть не нужна,
        // разрешение INTERNET в манифесте не появляется.
        WebView.setWebContentsDebuggingEnabled(true)

        // Голос: в WebView нет Web Speech API, поэтому озвучку даёт системный
        // движок Android через мост KomaSpeech.
        speech = KomaSpeechBridge(this) { web }
        // Нативное распознавание: модели живут в filesDir/models, считает
        // ONNX Runtime для Android. Страница получает те же строки с теми же
        // прямоугольниками, что давал браузерный конвейер.
        ocrEngine = OcrEngine(java.io.File(filesDir, "models"))
        ocr = KomaOcrBridge(this, ocrEngine, { web }) {
            runOnUiThread { pickModelFiles() }
        }
        // Модели встроены в сборку: раскладываем их в filesDir в фоне, чтобы
        // распознавание работало сразу после установки — без выбора файлов.
        // 12,6 МБ копируются доли секунды, но в главном потоке это «затык» на
        // старте, поэтому отдельный поток; страница переспросит готовность сама.
        ocrEngine.embedded = ocrEngine.embeddedInAssets(assets)
        if (ocrEngine.embedded) ocr.seed()

        // Плагины читалки: JSON-файлы рядом с приложением. Правки поведения
        // (правила, замены слов, голос) едут файлами, а не новой сборкой.
        plugins = KomaPluginsBridge(this) { web }

        web = WebView(this)
        // Страница и панель чтения — в одной колонке: страница сверху (занимает
        // всё свободное место), нативная панель снизу. Так панель никогда не
        // ложится на облачко с текстом и не пересчитывает высоту на каждой
        // реплике — то, из-за чего страница «дёргалась» (28.10).
        ui = KomaUiBridge(this) { web }
        val root = android.widget.LinearLayout(this)
        root.orientation = android.widget.LinearLayout.VERTICAL
        root.addView(web, android.widget.LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(ui.view, android.widget.LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        setContentView(root, ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = false               // всё отдаётся через https-домен приложения
            allowContentAccess = true             // выбор файлов моделей из «Файлов»
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            // Онлайн-голоса Edge: сервис Microsoft пускает только браузер Edge и
            // отвечает 403 любому другому User-Agent (проверено замерами 04.11:
            // Chrome / HeadlessChrome / Android WebView — 403, а с «Edg/» — mp3).
            // Поэтому к системному UA добавляем токен Edg той же мажорной версии.
            // Ничего не подделываем под чужое приложение: UA остаётся честным
            // «это Chromium такой-то версии», плюс метка своей сборки.
            val chromeMajor = Regex("Chrome/(\\d+)").find(userAgentString)?.groupValues?.get(1) ?: "143"
            userAgentString = userAgentString + " Edg/$chromeMajor.0.0.0 KOMAApp/$appVersion"
        }
        // Сборка локальная: сторонние cookie и внешние сайты не нужны вовсе.
        CookieManager.getInstance().setAcceptCookie(false)

        // Постоянный адрес страницы: обновление файла не сбрасывает IndexedDB.
        val loader = WebViewAssetLoader.Builder()
            .setDomain(DOMAIN)
            .addPathHandler("/web/", HtmlHandler())
            .build()

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                val r = request ?: return null
                loader.shouldInterceptRequest(r.url)?.let { return it }
                // Всё, чего нет в АПК (favicon.ico, служебные файлы), закрываем
                // пустым ответом. Иначе WebView идёт в сеть, получает
                // ERR_NAME_NOT_RESOLVED и рисует «страница не открылась» поверх
                // рабочей читалки — ровно это и было на телефоне 17:24.
                return if (r.url.host == DOMAIN) {
                    WebResourceResponse("text/plain", "utf-8", java.io.ByteArrayInputStream(ByteArray(0)))
                } else {
                    null
                }
            }

            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val u = request?.url ?: return false
                // В локальной сборке внешних ссылок нет: остаёмся на своём домене.
                if (u.host == DOMAIN) return false
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, u)); true
                } catch (e: Exception) { false }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                // После загрузки сообщаем странице, какая версия оболочки: в
                // «Правилах» появится блок «Приложение» (только внутри АПК).
                view?.evaluateJavascript(
                    "window.__komaAppVersion=${quote(appVersion)};document.dispatchEvent(new Event('koma-app'));",
                    null
                )
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(msg: android.webkit.ConsoleMessage?): Boolean {
                msg?.let { Log.d("KomaWeb", "${it.messageLevel()} ${it.message()} @${it.lineNumber()}") }
                return true
            }

            override fun onShowFileChooser(
                view: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                params: FileChooserParams?,
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try {
                    val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)   // три файла моделей сразу
                    }
                    startActivityForResult(Intent.createChooser(intent, "Выберите файлы моделей"), RC_FILES)
                    true
                } catch (e: Exception) {
                    fileCallback = null
                    false
                }
            }

            override fun onJsAlert(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
                // confirm()/prompt() в читалке не используются намеренно, но если
                // появятся — не вешаем страницу.
                Toast.makeText(this@MainActivity, message ?: "", Toast.LENGTH_LONG).show()
                result?.confirm()
                return true
            }
        }

        web.addJavascriptInterface(speech, "KomaSpeech")
        web.addJavascriptInterface(ocr, "KomaOcr")
        web.addJavascriptInterface(plugins, "KomaPlugins")
        web.addJavascriptInterface(readEngine, "KomaRead")
        web.addJavascriptInterface(ui, "KomaUi")
        web.addJavascriptInterface(
            KomaAppBridge(appVersion, BuildConfig.PAGE_VERSION) { reason -> runOnUiThread { reload(reason) } },
            "KomaApp"
        )
        // Мост KomaApp отвечает странице событиями — ему нужен тот же WebView.
        KomaAppBridge.HOST = java.lang.ref.WeakReference(web)

        web.loadUrl(START_URL)

        // Автообновления нет намеренно: сборка локальная. Ничего не тянется из
        // сети, поэтому нечему «проверяться» и незачем просить интернет.
    }

    private fun reload(reason: String) {
        Toast.makeText(this, reason, Toast.LENGTH_LONG).show()
        web.loadUrl(START_URL)
    }

    /**
     * Отдаём читалку: сначала обновлённый файл из filesDir, иначе встроенный
     * из assets. Оба — по одному и тому же адресу, поэтому для страницы это
     * одна и та же установка.
     */
    private inner class HtmlHandler : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): WebResourceResponse? {
            val name = path.removePrefix("/")
            if (name != "koma-web.html" && name != "index.html" && name != "") return null
            return try {
                WebResourceResponse("text/html", "utf-8", assets.open("koma-web.html"))
            } catch (e: IOException) {
                Log.e("Koma", "нет ни обновлённого файла, ни встроенного", e)
                null
            }
        }
    }

    /** Системный выбор файлов моделей для нативного движка. */
    /** Системный выбор файлов плагина (.json). */
    fun pickPluginFiles() {
        try {
            val it = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/json", "text/plain", "application/octet-stream"))
            }
            startActivityForResult(it, RC_PLUGIN)
        } catch (e: Exception) {
            runOnUiThread { Toast.makeText(this, "Выбор файлов не открылся: ${e.message}", Toast.LENGTH_LONG).show() }
        }
    }

    private fun pickModelFiles() {
        try {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            }
            startActivityForResult(Intent.createChooser(intent, "Выберите файлы моделей (det, rec, азбука)"), RC_MODELS)
        } catch (e: Exception) {
            Toast.makeText(this, "Не удалось открыть выбор файлов: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    /** Итог системного выбора файлов — отдаём странице. */
    @Deprecated("framework API: ActivityResult стартует библиотеку, а нам хватает этого")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == RC_MODELS) {
            val uris = ArrayList<Uri>()
            val cd = data?.clipData
            if (cd != null) for (i in 0 until cd.itemCount) uris.add(cd.getItemAt(i).uri)
            data?.data?.let { uris.add(it) }
            if (uris.isEmpty()) { Toast.makeText(this, "Файлы не выбраны", Toast.LENGTH_SHORT).show(); return }
            val res = ocr.importFiles(uris)
            Toast.makeText(this, if (res.optBoolean("ok"))
                "Модели скопированы в приложение. Проверяю…" else
                "Не получилось: " + res.optString("error"), Toast.LENGTH_LONG).show()
            // Страница обновит состояние и, если движок готов, включит нативный путь.
            web.evaluateJavascript(
                "try{window.dispatchEvent(new CustomEvent('koma-models',{detail:" +
                JSONObject.quote(res.toString()) + "}));}catch(e){}", null)
            return
        }
        if (requestCode == RC_PLUGIN) {
            val uris = ArrayList<Uri>()
            try {
                val clip = data?.clipData
                if (clip != null) for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri)
                else data?.data?.let { uris.add(it) }
            } catch (e: Exception) { /* ниже скажем, что ничего не выбрано */ }
            val res = plugins.importUris(uris)
            runOnUiThread {
                Toast.makeText(this,
                    if (res.optBoolean("ok")) "Плагин добавлен: " + res.optJSONArray("saved")
                    else "Плагин не добавлен: " + res.optString("error"),
                    Toast.LENGTH_LONG).show()
            }
            web.post {
                web.evaluateJavascript(
                    "try{window.dispatchEvent(new CustomEvent('koma-plugins',{detail:" +
                    JSONObject.quote(res.toString()) + "}));}catch(e){}", null)
            }
            return
        }
        if (requestCode != RC_FILES) return
        val cb = fileCallback ?: return
        fileCallback = null
        val uris: Array<Uri>? = when {
            data == null -> null
            (data.clipData?.itemCount ?: 0) > 1 -> (0 until data.clipData!!.itemCount)
                .map { data.clipData!!.getItemAt(it).uri }.toTypedArray()
            data.data != null -> arrayOf(data.data!!)
            else -> null
        }
        cb.onReceiveValue(uris)
    }

    override fun onBackPressed() {
        // Как в браузере: сначала «назад» внутри читалки, потом выход.
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    override fun onPause() {
        super.onPause()
        // Голос должен замолчать при уходе из приложения, иначе читает в кармане.
        try { speech.stopAll() } catch (e: Exception) { }
        web.evaluateJavascript(
            "try{window.VOICE&&VOICE.cancel&&VOICE.cancel();" +
            "window.speechSynthesis&&window.speechSynthesis.cancel&&window.speechSynthesis.cancel();" +
            "window.TTS&&TTS.stop&&TTS.stop();}catch(e){}", null)
    }

    override fun onDestroy() {
        try { speech.shutdown() } catch (e: Exception) { }
        try { ocrEngine.reset() } catch (e: Exception) { }
        web.destroy()
        super.onDestroy()
    }

    private fun quote(s: String) = "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"

    companion object {
        private const val DOMAIN = "appassets.androidplatform.net"
        private const val START_URL = "https://$DOMAIN/web/koma-web.html"
    }
}

@Suppress("unused")
private fun View.hide() { visibility = View.GONE }
