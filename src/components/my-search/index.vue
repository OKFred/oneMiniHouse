<template>
  <view class="my-center-vertically my-far-table"
    :style="`width: 100%; ${parentObj.iconPosition === 'right' ? 'flex-direction: row-reverse;' : ''}`">
    <view v-if="parentObj.icon" class="my-center-vertically" style="display: flex; padding: 0 1vh;"
      @tap="parentObj.onIconClick?.()">
      <text style="padding: 0.1rem;">{{ parentObj.iconLabel }}</text>
      <image :src="parentObj.icon" style="height: 22px; width: 22px;" />
    </view>
    <u-search v-model="parentObj.userSearch" :show-action="true" :placeholder="parentObj.placeholder"
      @change="(value) => value === '' && parentObj.onSearch({ value, parent: parentObj.parent })"
      @search="(value) => parentObj.onSearch({ value, parent: parentObj.parent })"
      @clear="(value) => parentObj.onSearch({ value, parent: parentObj.parent })" height="5vh"
      :inputStyle="`font-size: 1rem;`" :actionStyle="`font-size: 1rem; font-weight: bold;`" actionText="搜索" shape="square"
      :animation="true" bgColor="#F7F7F7" />
  </view>
</template>

<script setup>
//框架引入
import {
  reactive,
  watch,
  computed,
  onMounted,
  onActivated,
  onDeactivated,
  onUpdated,
  defineProps,
} from "vue";

//组件引入
// import uSearch from "uview-ui/components/u-search/u-search.vue"

//父系入参
const props = defineProps({
  parentObj: {
    type: Object,
    validator(obj) {
      if (obj) {
        if (
          typeof obj.onSearch !== "function"
        )
          return console.log("⚠️搜索处理函数未传入");
      }
    },
  },
});

</script>

<style></style>
