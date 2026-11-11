<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Entry, QueuedEntryView, Slot, WallState } from '../types'
import { copy } from '../copy'
import { groupByDay } from '../lib/grouping'
import DayGroup from './DayGroup.vue'
import StreamLine from './StreamLine.vue'

/**
 * 留言流渲染（滚动由外层控制，这里只管结构）。
 * 自上而下：顶部哨兵 → 派生语 → 邀请行 → 空墙行 → 日分组 → 排队区 → 提示行 → 设置入口。
 * 留言正文一律 {{ }} 渲染；邀请链接是纯文本行，不是 <a>。
 */
const props = withDefaults(
  defineProps<{
    /** 已寄出留言，按 seq 升序 */
    entries: Entry[]
    /** 本设备尚未寄出的文字，按写下顺序 */
    queued: QueuedEntryView[]
    mySlot: Slot
    state: WallState
    /** 居中派生语，如座位建立 */
    derived: string[]
    /** 流尾本地语（错误/状态），仅自己可见 */
    notices: string[]
    /** 空墙文案；非空时才渲染空墙行 */
    emptyLine: string | null
    /** nascent 创建者的邀请链接行；b 占座后为 null */
    inviteUrl: string | null
    hasMore: boolean
    /** 本次来访新增基线：seq > freshSeq 的留言附加 .entry--new（120ms 淡入） */
    freshSeq?: number
  }>(),
  { freshSeq: 0 },
)

const emit = defineEmits<{
  (e: 'load-older'): void
  (e: 'open-settings'): void
  (e: 'retract-queued', clientUuid: string): void
}>()

const dayGroups = computed(() => groupByDay(props.entries))

/** 排队区两步撤回：先展开确认词，再点才真的撤回。逐条独立。 */
const armed = ref<Set<string>>(new Set())

function isArmed(clientUuid: string): boolean {
  return armed.value.has(clientUuid)
}

function armRetract(clientUuid: string): void {
  const next = new Set(armed.value)
  next.add(clientUuid)
  armed.value = next
}

function retract(clientUuid: string): void {
  const next = new Set(armed.value)
  next.delete(clientUuid)
  armed.value = next
  emit('retract-queued', clientUuid)
}

/**
 * 顶部哨兵：进入视口且 hasMore 时触发一次 load-older（去抖）。
 * hasMore 或留言列表变化后复位，允许下一次上翻再触发。
 */
const sentinel = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | null = null
let loadRequested = false

function tryLoadOlder(): void {
  if (loadRequested || !props.hasMore) return
  loadRequested = true
  emit('load-older')
}

onMounted(() => {
  if (typeof IntersectionObserver === 'undefined') return
  const target = sentinel.value
  if (target === null) return
  observer = new IntersectionObserver((records) => {
    for (const record of records) {
      if (record.isIntersecting) tryLoadOlder()
    }
  })
  observer.observe(target)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})

watch(
  () => [props.hasMore, props.entries] as const,
  () => {
    loadRequested = false
  },
)
</script>

<template>
  <div class="stream" :data-state="state">
    <div
      ref="sentinel"
      class="stream-sentinel"
      data-testid="stream-sentinel"
      aria-hidden="true"
    />

    <StreamLine
      v-for="(line, index) in derived"
      :key="`derived-${index}`"
      variant="derived"
      :text="line"
      testid="derived-line"
    />

    <StreamLine
      v-if="inviteUrl !== null"
      variant="invite"
      :text="copy.inviteLinkLine(inviteUrl)"
      testid="invite-line"
    />

    <StreamLine v-if="emptyLine !== null" variant="empty" :text="emptyLine" testid="empty-line" />

    <DayGroup
      v-for="group in dayGroups"
      :key="group.entries[0].id"
      :label="group.label"
      :entries="group.entries"
      :my-slot="mySlot"
      :fresh-seq="freshSeq"
    />

    <div
      v-for="item in queued"
      :key="item.client_uuid"
      class="entry entry--queued entry--mine"
      data-testid="entry"
      :data-slot="mySlot"
      :data-client-uuid="item.client_uuid"
    >
      <div class="entry-body">{{ item.body }}</div>
      <template v-if="item.failed">
        <button
          v-if="!isArmed(item.client_uuid)"
          type="button"
          class="local-line"
          data-testid="queued-line"
          @click="armRetract(item.client_uuid)"
        >
          {{ copy.queued }}
        </button>
        <button
          v-else
          type="button"
          class="local-line"
          data-testid="retract-line"
          @click="retract(item.client_uuid)"
        >
          {{ copy.retractQueued }}
        </button>
      </template>
    </div>

    <StreamLine
      v-for="(line, index) in notices"
      :key="`notice-${index}`"
      variant="notice"
      :text="line"
      testid="notice-line"
    />

    <div class="settings-entry">
      <button type="button" class="word" data-testid="settings-entry" @click="emit('open-settings')">
        {{ copy.words.settings }}
      </button>
    </div>
  </div>
</template>
