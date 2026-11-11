<script setup lang="ts">
import { computed } from 'vue'

/**
 * 流中的一行纯文本说明（派生语 / 邀请链接 / 本地语 / 空墙文案 / 提示行）。
 * 不解析、不生成链接、不含交互：任何可点的词由使用方以 <button class="word"> 呈现。
 */
type StreamLineVariant = 'derived' | 'invite' | 'notice' | 'local' | 'empty'

const props = withDefaults(
  defineProps<{
    /** 行文字，必须来自 copy.ts */
    text: string
    variant?: StreamLineVariant
    /** 透传给 QA 的 data-testid */
    testid?: string
  }>(),
  { variant: 'derived' },
)

const CLASS_BY_VARIANT: Record<StreamLineVariant, readonly string[]> = {
  derived: ['derived-line'],
  invite: ['invite-line'],
  notice: ['notice-line'],
  local: ['local-line'],
  empty: ['derived-line', 'empty-line'],
}

const classes = computed(() => CLASS_BY_VARIANT[props.variant])
</script>

<template>
  <p :class="classes" :data-testid="testid">{{ text }}</p>
</template>
