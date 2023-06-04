<template>
  <myFooter>
    <template #myFooterSlot>
      <view class="my-center my-center-vertically my-around-table" style="width: 100%;">
        <view class="my-far-table" v-if="!localObj.footers.readOnly">
          <view class="my-center my-center-vertically my-button-default" style="color: #114FFF; background: #FFFFFF;"
            @tap="onNavBack()">
            返回
          </view>
          <view class="my-center my-center-vertically my-button-default" style="color: white; background: #114FFF;"
            @tap="onSave()">
            确定
          </view>
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

//父系入参
const { onNav, onNavBack } = globalThis.app;

const props = defineProps({
  localObj: Object,
});

function setData(obj) {
  Object.assign(props.localObj, obj);
}

//本地变量和函数
setData({
  footers: {
  },
});


function onSave() {
  let fn = /更新/.test(props.localObj.pageName) ? "updates" : "adds";
  let formObj_main = props.localObj.forms.find((item) => item.parent === "主表单");
  let data = {};
  if (fn === "updates") {
    data.id = props.localObj.query.id;
  }
  formObj_main.formArr.forEach((item) => {
    data[item.key] = item.value;
  });
  data['freezerFeesSaveParam'] = [];
  let chargeFeeObj = formObj_main.formArr.find(obj => obj.label === '收费标准');
  let { optionArr, selectArr, inputArr } = chargeFeeObj;
  for (let i = 0; i < optionArr.length; i++) {
    let { value } = optionArr[i] || {};
    if (selectArr.includes(value) && inputArr[i]) {
      data['freezerFeesSaveParam'].push({
        feeCycleId: value,
        fees: inputArr[i]
      })
    }
  }
  props.localObj.fn.loadData({ [fn]: data });
}

</script>

<style>
.my-button-default {
  width: 50vw;
  height: 6vh;
}
</style>
