<script setup lang="ts">
import { computed } from 'vue'
import type { Entry } from '../types'
import { copy } from '../copy'

/**
 * 一条留言：身份编码三重冗余里的字重/墨色由 .entry--mine / .entry--theirs 承载，
 * 屏幕阅读器通道由视觉隐藏前缀承担（SPEC §4.3）。正文用 textContent 语义渲染，
 * 换行由 .entry-body 的 white-space: pre-wrap 保留，不解析任何标记。
 */
const props = withDefaults(
  defineProps<{
    entry: Entry
    /** 是否属于我的座位 */
    mine: boolean
    /** 本次来访新增（仅该条 120ms 淡入） */
    fresh?: boolean
  }>(),
  { fresh: false },
)

const srPrefix = computed(() => (props.mine ? copy.srMine : copy.srTheirs))
</script>

<template>
  <article
    class="entry"
    :class="[mine ? 'entry--mine' : 'entry--theirs', { 'entry--new': fresh }]"
    data-testid="entry"
    :data-seq="entry.seq"
    :data-slot="entry.slot"
  >
    <span class="sr-only">{{ srPrefix }}</span>
    <div class="entry-body">{{ entry.body }}</div>
  </article>
</template>
