package net.koma.reader

import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject

/**
 * Мост приложения в ЛОКАЛЬНОЙ сборке: только сведения и перезагрузка.
 *
 * Здесь нет ни проверки обновлений, ни Lens: сборка не имеет разрешения на
 * интернет вообще. Страница спрашивает `checkUpdate` и `lensSelfTest` только
 * тогда, когда эти кнопки видны; отвечаем честно «в этой сборке недоступно»,
 * чтобы ни одна кнопка не молчала.
 */
class KomaAppBridge(
    private val appVersion: String,
    private val pageVersion: String,
    private val reload: (String) -> Unit,
) {

    @JavascriptInterface
    fun version(): String = JSONObject()
        .put("app", appVersion)
        .put("page", pageVersion)
        .put("offline", true)
        .toString()

    /** Обновлений нет: сборка локальная, тянуть нечего и нечем. */
    @JavascriptInterface
    fun checkUpdate(cbId: String) {
        val done = JSONObject().put("updated", false)
            .put("reason", "локальная сборка: без интернета и без обновлений")
            .toString()
        post(cbId, "done", done)
    }

    @JavascriptInterface
    fun lensSelfTest(): String = JSONObject()
        .put("ok", false)
        .put("note", "Lens в локальной сборке отключён намеренно")
        .toString()

    @JavascriptInterface
    fun reloadNow(reason: String) = reload(reason.ifBlank { "перезагрузка" })

    private fun post(cbId: String, type: String, text: String) {
        val id = JSONObject.quote(cbId)
        val t = JSONObject.quote(type)
        val d = JSONObject.quote(text)
        reloadHost()?.let { ws ->
            ws.post { ws.evaluateJavascript("window.__komaAppEvent&&window.__komaAppEvent($id,$t,$d)", null) }
        }
    }

    private fun reloadHost(): WebView? = HOST?.get()

    companion object {
        /** WebView ставится один раз из Activity — так у моста нет циклической ссылки. */
        @Volatile
        var HOST: java.lang.ref.WeakReference<WebView>? = null
    }
}
