<script setup lang="ts">
/**
 * 墙屏：流滚动、阅读位置定位、来访同步、下拉手势、寄出后 160ms 滚动。
 * A3：本屏不产生任何对方可观测信号；同步只在来访触发（挂载 / 可见 / 下拉 / 寄出成功）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { copy } from '../copy'
import { queuedViews, wall } from '../lib/store'
import { derivedLines } from '../lib/grouping'
import { readLastSeen, resolveAnchorSeq } from '../lib/read-position'
import { SYNC_MIN_INTERVAL_MS } from '../lib/sync-constants'
import type { Entry } from '../types'
import EntryStream from './EntryStream.vue'
import Composer from './Composer.vue'

const streamEl = ref<HTMLElement | null>(null)
const atBottom = ref(true)
const freshSeq = ref(Number.MAX_SAFE_INTEGER)

const queued = computed(() => queuedViews.value)
const mine = computed(() => wall.snapshot?.my_slot ?? 'a')
const state = computed(() => wall.snapshot?.state ?? 'nascent')
const isClosed = computed(() => state.value === 'closed')
const derived = computed(() => (wall.snapshot ? derivedLines(wall.snapshot) : []))

const emptyLine = computed(() => {
  if (!wall.snapshot || isClosed.value) return null
  if (wall.entries.length > 0 || wall.queue.length > 0) return null
  return wall.snapshot.seats.length >= 2 ? copy.emptyAcceptor : copy.emptyCreator
})

let initialized = false
let scrollRaf = 0
let lastRecordedSeq = -1
let lastKnownScrollHeight = 0
let touchStartY = 0
let pullActive = false

function isNearBottom(el: HTMLElement, threshold = 24): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold
}

function recordSeen(el: HTMLElement): void {
  const containerBottom = el.getBoundingClientRect().bottom
  let highest = -1
  for (const node of el.querySelectorAll<HTMLElement>('[data-seq]')) {
    if (node.getBoundingClientRect().top < containerBottom - 8) {
      highest = Math.max(highest, Number(node.dataset.seq))
    }
  }
  if (highest > 0 && highest !== lastRecordedSeq) {
    lastRecordedSeq = highest
    wall.markSeen(highest)
  }
}

function onScroll(): void {
  if (scrollRaf) return
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0
    const el = streamEl.value
    if (!el) return
    atBottom.value = isNearBottom(el)
    lastKnownScrollHeight = el.scrollHeight
    recordSeen(el)
  })
}

function scrollToBottomAnimated(duration = 160): void {
  const el = streamEl.value
  if (!el) return
  const target = el.scrollHeight - el.clientHeight
  if (target <= el.scrollTop + 1) return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.scrollTop = target
    return
  }
  const start = el.scrollTop
  const t0 = performance.now()
  const step = (now: number): void => {
    const progress = Math.min(1, (now - t0) / duration)
    el.scrollTop = start + (target - start) * progress
    if (progress < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

/** 首次进入：有 last_seen_seq 停在上次离开处；没有则停在第一封信的日期组首。 */
function anchorInitial(): void {
  const el = streamEl.value
  if (!el) return
  if (wall.entries.length === 0) {
    el.scrollTop = 0
    return
  }
  const lastSeen = readLastSeen()
  if (lastSeen === null) {
    el.scrollTop = 0
    return
  }
  const anchorSeq = resolveAnchorSeq(wall.entries, lastSeen)
  if (anchorSeq === null) {
    el.scrollTop = 0
    return
  }
  const target = el.querySelector<HTMLElement>(`[data-seq="${anchorSeq}"]`)
  if (!target) {
    el.scrollTop = 0
    return
  }
  const elRect = el.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  // 让上次离开处停在视口底边：新留言在下方，位置本身即唯一提示（不加"新"标记）。
  el.scrollTop += targetRect.bottom - elRect.bottom + 16
  atBottom.value = isNearBottom(el)
  lastKnownScrollHeight = el.scrollHeight
}

function latestSeq(entries: Entry[]): number {
  return entries.length > 0 ? entries[entries.length - 1].seq : 0
}

watch(
  () => wall.entries,
  async (entries, previous) => {
    await nextTick()
    const el = streamEl.value
    if (!initialized) {
      initialized = true
      freshSeq.value = latestSeq(entries)
      anchorInitial()
      if (el) lastKnownScrollHeight = el.scrollHeight
      return
    }
    const previousFirst = previous?.[0]?.seq
    const currentFirst = entries[0]?.seq
    const prepended =
      el !== null &&
      previousFirst !== undefined &&
      currentFirst !== undefined &&
      entries.length > (previous?.length ?? 0) &&
      currentFirst < previousFirst
    if (prepended && el) {
      // 上翻加载更早一页：保持视口不动（内容从顶部插入，补偿高度差）
      el.scrollTop += el.scrollHeight - lastKnownScrollHeight
      lastKnownScrollHeight = el.scrollHeight
      atBottom.value = isNearBottom(el)
      return
    }
    if (atBottom.value && el) {
      scrollToBottomAnimated(160)
      atBottom.value = true
      lastKnownScrollHeight = el.scrollHeight
    }
  },
  { flush: 'post' },
)

watch(
  () => wall.queue.length,
  async (length, previous) => {
    if (length > previous && atBottom.value) {
      await nextTick()
      scrollToBottomAnimated(160)
    }
  },
  { flush: 'post' },
)

function onVisibilityChange(): void {
  const el = streamEl.value
  if (document.visibilityState === 'hidden') {
    if (el) recordSeen(el)
    return
  }
  if (Date.now() - wall.lastSyncAt > SYNC_MIN_INTERVAL_MS) void wall.sync()
}

function onOnline(): void {
  void wall.retryQueue()
  if (Date.now() - wall.lastSyncAt > SYNC_MIN_INTERVAL_MS) void wall.sync()
}

function onTouchStart(event: TouchEvent): void {
  const el = streamEl.value
  if (!el || el.scrollTop > 0) return
  pullActive = true
  touchStartY = event.touches[0]?.clientY ?? 0
}

function onTouchMove(event: TouchEvent): void {
  if (!pullActive) return
  const el = streamEl.value
  if (!el) return
  const dy = (event.touches[0]?.clientY ?? 0) - touchStartY
  if (dy > 0 && el.scrollTop <= 0) {
    if (event.cancelable) event.preventDefault()
    if (dy >= 64) {
      pullActive = false
      void wall.sync()
    }
  } else {
    pullActive = false
  }
}

function onTouchEnd(): void {
  pullActive = false
}

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('online', onOnline)
  window.addEventListener('beforeunload', () => {
    const el = streamEl.value
    if (el) recordSeen(el)
  })
  const el = streamEl.value
  if (el) {
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
  }
  // 挂载即一次完整同步（§3.4）；boot 已加载首屏，因此仅在数据可能过期时补一次。
  if (Date.now() - wall.lastSyncAt > SYNC_MIN_INTERVAL_MS) void wall.sync()
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('online', onOnline)
  const el = streamEl.value
  if (el) {
    el.removeEventListener('touchstart', onTouchStart)
    el.removeEventListener('touchmove', onTouchMove)
    el.removeEventListener('touchend', onTouchEnd)
  }
  if (scrollRaf) cancelAnimationFrame(scrollRaf)
})
</script>

<template>
  <div class="wall">
    <main ref="streamEl" class="stream-scroll" data-testid="stream" @scroll.passive="onScroll">
      <EntryStream
        v-if="wall.snapshot"
        :entries="wall.entries"
        :queued="queued"
        :my-slot="mine"
        :state="state"
        :derived="derived"
        :notices="wall.notices"
        :empty-line="emptyLine"
        :invite-url="wall.inviteUrl"
        :has-more="wall.hasMore"
        :fresh-seq="freshSeq"
        @load-older="wall.loadOlder()"
        @open-settings="wall.openSettings()"
        @retract-queued="wall.retractQueued"
      />
    </main>
    <Composer
      v-if="!isClosed"
      :show-shortcut-hint="wall.shortcutHintVisible"
      @commit="wall.post"
    />
  </div>
</template>
