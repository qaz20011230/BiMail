<script setup lang="ts">
import type { Entry, Slot } from '../types'
import EntryRow from './EntryRow.vue'

/**
 * 一个日游程：一个日期标签 + 若干留言。
 * 标签允许非单调重复（跨日界写作时），不排序、不重排、不显示相对时间。
 */
withDefaults(
  defineProps<{
    label: string
    entries: Entry[]
    mySlot: Slot
    /** 本次来访新增的基线：seq > freshSeq 的条目附加 .entry--new */
    freshSeq?: number
  }>(),
  { freshSeq: 0 },
)
</script>

<template>
  <div class="day-group" data-testid="day-group">
    <h2 class="day-label" data-testid="day-label">{{ label }}</h2>
    <EntryRow
      v-for="entry in entries"
      :key="entry.id"
      :entry="entry"
      :mine="entry.slot === mySlot"
      :fresh="entry.seq > freshSeq"
    />
  </div>
</template>
