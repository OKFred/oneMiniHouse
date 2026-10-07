<template>
  <myTab :parentObj="localObj.tabs" />
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
import myTab from "/src/components/my-tab/index.vue";

//父系入参
const { onNav, onNavBack, globalData } = globalThis.app;

const props = defineProps({
  localObj: Object,
});

function setData(obj) {
  Object.assign(props.localObj, obj);
}

//本地变量和函数
setData({
  tabs: {
    onTabChange,
    tabArr: [
      { name: '文本', value: '1' },
      { name: '图表', value: '2' },
    ],
    currentTab: '文本',
    currentIndex: 0,
    tabKey: 'type'
  }
});

function onTabChange(tabs) {
  let { currentIndex, tabArr, tabKey } = tabs;
  let { value } = tabArr[currentIndex];
  return;
  props.localObj.fn.clearRequestHistory?.()
  props.localObj.requestParamObj = { ...props.localObj.requestParamObj, [tabKey]: value };
  props.localObj.fn.loadData?.({ lists: props.localObj.requestParamObj })
}
</script>

<style></style>
