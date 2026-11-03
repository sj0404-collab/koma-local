package net.koma.reader

import android.util.Log

/**
 * Один журнал на всё приложение.
 *
 * Раньше логировать умел класс Lens-движка, и им пользовались все остальные —
 * когда Lens из локальной сборки убрали, журнал остался бы без хозяина. Теперь
 * это отдельный маленький объект: он есть всегда и ни от чего не зависит.
 */
object KomaLog {
    private const val TAG = "KomaLocal"

    fun log(message: String) {
        Log.d(TAG, message)
    }

    fun error(message: String, e: Throwable? = null) {
        Log.e(TAG, message, e)
    }
}
