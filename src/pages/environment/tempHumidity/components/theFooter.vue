<template>
  <myFooter>
    <template #myFooterSlot>
      <view slot="myFooterSlot" class="my-center my-center-vertically my-around-table" style="width: 100%">
        <view style="width: 88vw" @tap="onCancel">
          <mybuttond :parentObj="localObj.footers.buttons" />
        </view>
      </view>
    </template>
  </myFooter>
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
import myFooter from "/src/components/my-footer/index.vue"; //引入组件
import mybuttond from "/src/components/mybuttond/index.vue"; //引入组件

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
  // debug: true,
  footers: {
    buttons: {
      text: "返回",
      disabled: false,
    },
    // readOnly: true, //只读
  },
});

function onCancel() {
  app.onNavBack()
}

function onSubmit() {
  console.log("提交表单");
}
</script>

<style>

</style>
