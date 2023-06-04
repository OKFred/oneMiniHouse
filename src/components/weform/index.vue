<template>
  <picker mode="date" v-if="parentObj.type === 'date'" :value="localObj.formObj.date" @change="
    (e) =>
      parentObj.onDateChange({ e, ...e.detail, parent: parentObj.parent })
  " class="my-picker">
    <slot :localObj="localObj" name="datePicker">
      <button>请选择日期</button>
    </slot>
    <text v-if="parentObj.debug" class="my-inline-text my-ellipsis">
      {{ localObj.formObj.date || "请选择日期" }}
    </text>
  </picker>
  <picker mode="time" v-if="parentObj.type === 'time'" :value="localObj.formObj.time" @change="
    (e) =>
      parentObj.onTimeChange({ e, ...e.detail, parent: parentObj.parent })
  " class="my-picker">
    <slot :localObj="localObj" name="timePicker">
      <button>请选择时间</button>
    </slot>
    <text v-if="parentObj.debug" class="my-inline-text my-ellipsis">
      {{ localObj.formObj.time || "请选择时间" }}
    </text>
  </picker>
  <picker mode="region" level="region" v-else-if="parentObj.type === 'region'" :value="localObj.formObj.region"
    :onChange="
      (e) =>
        parentObj.onRegionChange({
          e,
          ...e.detail,
          index,
          parent: parentObj.parent,
        })
    " class="my-picker">
    <slot :localObj="localObj" name="regionPicker">
      <button>请选择地区</button>
    </slot>
    <text class="my-inline-text my-ellipsis my-region-text" v-if="parentObj.debug">
      <text v-for="(item, index) in localObj.formObj.region" :key="index">
        {{ item }}{{ index !== 2 ? "," : "" }}
      </text>
    </text>
  </picker>
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

//父系入参
const { onNav, onNavBack, globalData } = globalThis.app;

const props = defineProps({
  parentObj: {
    type: Object,
    validator(obj) {
      if (obj) {
        if (
          (obj.type === 'date' && typeof obj.onDateChange !== "function")
          || (obj.type === 'time' && typeof obj.onTimeChange !== "function")
          || (obj.type === 'region' && typeof obj.onRegionChange !== "function")
        )
          return console.log("⚠️表单处理函数未传入");
      }
    },
  },
});

//本地变量和函数
let localObj = reactive({
  formObj: {
    date: new Date().Format("yyyy-MM-dd"),
    region: ["云南省", "玉溪市", "通海县"],
  },
});
</script>

<style>
.my-picker {
  display: inline-block;
}

.my-region-text {
  display: flex;
  flex-direction: row-reverse;
  text-overflow: unset;
  width: 43vw;
}
</style>
