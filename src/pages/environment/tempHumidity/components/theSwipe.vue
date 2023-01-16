<template>
  <myswipes>
    <template #mySwipeSlot>
      <view style="height: 2.5rem; padding-top: 1rem" class="my-center-vertically">
        <view> 滑动菜单内容⚠️✅ </view>
      </view>
    </template>
  </myswipes>
</template>

<script setup>
//框架引入
import Taro from "@tarojs/taro";
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
import myswipes from "@/src/components/myswipes/index.vue"; //引入组件

definePageConfig({
  navigationStyle: "custom",
  usingComponents: {
  },
});

//父系入参
const { onNav, onNavBack } = globalThis.app;

const props = defineProps({
  localObj: Object,
});

function setData(obj) {
  Object.assign(props.localObj, obj);
}

setData({
  // debug: true,
});
</script>

<style>
.my-cell {
  padding: 0rem !important;
  background-color: transparent !important;
}

.my-cell-group {
  margin-top: 1rem !important;
}

.my-swipe-card {
  height: 4rem;
  background-color: white;
}

.my-swipe-button {
  height: 4rem;
}
</style>
