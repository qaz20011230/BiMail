<script setup lang="ts">
/**
 * 输入框（docs/SPEC.md §3.2 / docs/CONTRACT.md §5.2）。
 *
 * 空态零控件；Enter 换行，Ctrl/Cmd+Enter 寄出；IME 候选确认的回车绝不寄出（P0）。
 * 草稿只写本设备 localStorage，永不上传；组件本身不发起任何网络请求。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { copy, shortcutLabel } from '../copy'
import { clearDraft, loadDraft, saveDraft } from '../lib/draft'
import {
  MAX_CODEPOINTS,
  excessCodepoints,
  insertPlainText,
  normalizeInput,
  truncateToCodepoints,
} from '../lib/input'

const props = withDefaults(defineProps<{ showShortcutHint?: boolean }>(), {
  showShortcutHint: false,
})

const emit = defineEmits<{ (e: 'commit', body: string): void }>()

/** 输入到写草稿的节流间隔。 */
const DRAFT_SAVE_DELAY_MS = 300
/** 组合结束后短暂忽略回车：个别浏览器先发 compositionend，再发确认用的 keydown。 */
const COMPOSITION_END_GUARD_MS = 50
/** 自增高上限：40vh。 */
const MAX_HEIGHT_RATIO = 0.4

const textarea = ref<HTMLTextAreaElement | null>(null)
const value = ref('')
const overflow = ref(0)

const hasValue = computed(() => value.value.length > 0)
// SPEC §3.1-8：这行提示「永久保留至第一次成功寄出」，输入过程中也不隐藏；
// 父组件在首次成功寄出后把 showShortcutHint 置为 false。
const hintVisible = computed(() => props.showShortcutHint)
const shortcutText = shortcutLabel(detectMac())

let draftTimer: ReturnType<typeof setTimeout> | null = null
let composing = false
let compositionEndedAt = Number.NEGATIVE_INFINITY
let viewport: VisualViewport | null = null

function detectMac(): boolean {
  if (typeof navigator === 'undefined') return false
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
  const platform = data?.platform ?? navigator.platform ?? ''
  if (platform.length > 0) return /mac|iphone|ipad|ipod/i.test(platform)
  return /mac os x|macintosh|iphone|ipad|ipod/i.test(navigator.userAgent)
}

/* —— 草稿：节流写、失焦/隐藏立即写，寄出即清 —— */

function cancelDraftTimer(): void {
  if (draftTimer !== null) {
    clearTimeout(draftTimer)
    draftTimer = null
  }
}

function scheduleDraftSave(body: string): void {
  cancelDraftTimer()
  if (body.length === 0) {
    clearDraft()
    return
  }
  draftTimer = setTimeout(() => {
    draftTimer = null
    saveDraft(body)
  }, DRAFT_SAVE_DELAY_MS)
}

function flushDraft(): void {
  cancelDraftTimer()
  saveDraft(value.value)
}

/* —— 自增高：最小 48px（CSS）到 40vh，超出内滚 —— */

function adjustHeight(): void {
  const element = textarea.value
  if (!element) return
  const maxHeight = Math.round(window.innerHeight * MAX_HEIGHT_RATIO)
  element.style.height = 'auto'
  const scrollHeight = element.scrollHeight
  if (scrollHeight <= 0) {
    element.style.height = ''
    element.style.overflowY = 'hidden'
    return
  }
  element.style.height = `${Math.min(scrollHeight, maxHeight)}px`
  element.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden'
}

/* —— 值写入：统一做超限截断、光标校正、草稿节流 —— */

function setValue(next: string, excess: number, caret?: number): void {
  overflow.value = Math.max(0, excess)
  value.value = next
  const element = textarea.value
  if (element) {
    if (element.value !== next) element.value = next
    if (caret !== undefined) {
      const position = Math.min(Math.max(0, caret), next.length)
      element.selectionStart = position
      element.selectionEnd = position
    }
    adjustHeight()
  }
  scheduleDraftSave(next)
}

function handleInput(event: Event): void {
  const element = event.target as HTMLTextAreaElement
  const raw = element.value
  const excess = excessCodepoints(raw)
  setValue(excess > 0 ? truncateToCodepoints(raw, MAX_CODEPOINTS) : raw, excess)
}

/* —— 粘贴：preventDefault，只取 text/plain，归一化 + 截断后插入 —— */

function handlePaste(event: ClipboardEvent): void {
  event.preventDefault()
  const element = textarea.value
  if (!element) return
  const pasted = event.clipboardData?.getData('text/plain') ?? ''
  if (pasted.length === 0) return
  const start = element.selectionStart ?? element.value.length
  const end = element.selectionEnd ?? start
  const insertion = insertPlainText(element.value, start, end, pasted, MAX_CODEPOINTS)
  setValue(insertion.value, insertion.excess, insertion.caret)
}

/* —— 键盘：Enter 换行，Ctrl/Cmd+Enter 寄出，IME 守卫 —— */

function inCompositionGuard(): boolean {
  return composing || Date.now() - compositionEndedAt < COMPOSITION_END_GUARD_MS
}

function handleKeydown(event: KeyboardEvent): void {
  if (inCompositionGuard() || event.isComposing || event.keyCode === 229) return
  if (event.key !== 'Enter') return
  if (!event.metaKey && !event.ctrlKey) return
  event.preventDefault()
  commit()
}

function handleCompositionStart(): void {
  composing = true
}

function handleCompositionEnd(): void {
  composing = false
  compositionEndedAt = Date.now()
}

/* —— 寄出：归一化 → 空白静默忽略 → 同步清空输入与草稿 → emit —— */

function clearInput(): void {
  cancelDraftTimer()
  overflow.value = 0
  value.value = ''
  const element = textarea.value
  if (element) {
    element.value = ''
    adjustHeight()
  }
  clearDraft()
}

function commit(): void {
  const body = truncateToCodepoints(normalizeInput(value.value), MAX_CODEPOINTS)
  if (body.trim().length === 0) return
  clearInput()
  emit('commit', body)
}

/* —— 移动端键盘吸底：把遮挡高度写进 CSS 变量 —— */

function setKeyboardInset(pixels: number): void {
  document.documentElement.style.setProperty('--bimail-keyboard-inset', `${Math.max(0, Math.round(pixels))}px`)
}

function resetKeyboardInset(): void {
  setKeyboardInset(0)
}

function updateKeyboardInset(): void {
  if (!viewport) {
    resetKeyboardInset()
    return
  }
  setKeyboardInset(window.innerHeight - viewport.height - viewport.offsetTop)
}

/* —— 失焦/隐藏：立即存草稿，键盘遮挡归零 —— */

function handleBlur(): void {
  flushDraft()
  resetKeyboardInset()
}

function handleVisibilityChange(): void {
  if (document.visibilityState === 'hidden') {
    flushDraft()
    resetKeyboardInset()
  }
}

function prefersFinePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(pointer: fine)').matches
  } catch {
    return false
  }
}

/* —— 暴露给上层的方法 —— */

function focus(): void {
  const element = textarea.value
  if (!element) return
  element.focus()
  const end = element.value.length
  element.selectionStart = end
  element.selectionEnd = end
}

defineExpose({ focus, clear: clearInput })

onMounted(() => {
  const draft = loadDraft()
  if (draft.length > 0) {
    const excess = excessCodepoints(draft)
    value.value = excess > 0 ? truncateToCodepoints(draft, MAX_CODEPOINTS) : draft
    overflow.value = excess
  }
  adjustHeight()

  document.addEventListener('visibilitychange', handleVisibilityChange)
  viewport = typeof window === 'undefined' ? null : (window.visualViewport ?? null)
  viewport?.addEventListener('resize', updateKeyboardInset)
  viewport?.addEventListener('scroll', updateKeyboardInset)
  updateKeyboardInset()

  // 桌面端：鼠标精确指针才自动聚焦；移动端不聚焦，避免键盘遮挡半屏。
  if (prefersFinePointer()) focus()
})

onBeforeUnmount(() => {
  flushDraft()
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  viewport?.removeEventListener('resize', updateKeyboardInset)
  viewport?.removeEventListener('scroll', updateKeyboardInset)
  viewport = null
  resetKeyboardInset()
})
</script>

<template>
  <div class="composer-dock">
    <p v-if="hintVisible" class="composer-hint faint">{{ copy.shortcutHint }}</p>
    <div class="composer">
      <textarea
        ref="textarea"
        class="composer-input"
        data-testid="composer-input"
        rows="1"
        :value="value"
        @input="handleInput"
        @paste="handlePaste"
        @keydown="handleKeydown"
        @compositionstart="handleCompositionStart"
        @compositionend="handleCompositionEnd"
        @blur="handleBlur"
      ></textarea>
      <div v-if="hasValue" class="composer-controls">
        <button type="button" class="word composer-word" data-testid="commit-word" @click="commit">
          {{ copy.words.commit }}
        </button>
        <span class="composer-shortcut faint">{{ shortcutText }}</span>
      </div>
      <p v-if="overflow > 0" class="composer-overflow faint">{{ copy.overLimit(overflow) }}</p>
    </div>
  </div>
</template>
