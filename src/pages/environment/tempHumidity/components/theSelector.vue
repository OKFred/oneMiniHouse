<template>
  <!-- 表单 -->
  <view style="background-color: white; padding: 1vh 2vw; margin: 1vh 2vw;">
    <myForm :parentObj="localObj.selectors[0]" />
  </view>
  <view style="margin-top: 1vh" />
</template>

<script setup>
//框架引入
import {
  reactive,
  watch,
  computed,
  onMounted,
  onBeforeUnmount,
  onActivated,
  onDeactivated,
  onUpdated,
  defineProps,
} from "vue";

//组件引入
import myForm from "/src/components/my-form/index.vue"; //引入组件

const props = defineProps({
  globalObj: Object,
  localObj: Object,
});

function setData(obj) {
  Object.assign(props.localObj, obj);
}

//本地变量和函数

setData({
  selectors: [
    {
      onEdit,
      onEditComplete,
      parent: "用户表单",
      formArr: [
        {
          label: "当前用户",
          name: '',
          value: 0,
          type: 'realSelect',
          "placeholder": '请选择',
          'option': 'users'
        },
      ],
    },
  ],
});

function onEdit(params) {
  let { obj, index, parent } = params;
  let formObj = props.localObj.selectors.find((obj) => obj.parent === parent);
  let { formArr } = formObj;
  // console.log("开始填写表单", obj, index);
  let { type, option } = obj; //表单类型
}

async function onEditComplete(params) {
  let { obj, index, value, name, parent } = params;
  let formObj = props.localObj.selectors.find((obj) => obj.parent === parent);
  let { formArr } = formObj;
  if (obj.label === '当前用户') {
    props.localObj.addressUpdate?.(value);
  }
  // console.log("表单已更新", JSON.parse(JSON.stringify(formArr))); 
}
</script>

<style></style>
