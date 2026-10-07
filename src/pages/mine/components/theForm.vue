<template>
  <view style="background-color: white; padding: 1vh 2vw; margin: 1vh 2vw;">
    <myForm :parentObj="localObj.forms[0]" />
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
import myForm from "/src/components/my-form/index.vue"; //引入组件

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
  forms: [
    {
      // readOnly: false,
      onEdit,
      onEditComplete,
      onUpload,
      onUploadComplete,
      onRemove,
      parent: "主表单",
      formArr: [
        {
          key: "address",
          label: "服务器地址",
          value: "",
          editing: false,
          type: "text",
          placeholder: "请输入服务器地址",
          required: true
        },
        {
          key: "port",
          label: "端口号",
          value: "",
          editing: false,
          type: "text",
          placeholder: "请输入端口号",
          required: true
        },
      ],
    },
  ],
});

onMounted(async () => {
  let { serverQuery } = props.localObj.fn;
  let serverObj = await serverQuery?.()
  let { address, port } = serverObj.result;
  let formObj = props.localObj.forms.find((obj) => obj.parent === '主表单');
  let { formArr } = formObj;
  formArr.find(obj => obj.label === '服务器地址').value = address;
  formArr.find(obj => obj.label === '端口号').value = port;
});

function onEdit(params) {
  let { obj, index, parent } = params;
  let formObj = props.localObj.forms.find((obj) => obj.parent === parent);
  let { formArr } = formObj;
  // console.log("开始填写表单", obj, index);
  let { type, option } = obj; //表单类型
}

async function onEditComplete(params) {
  let { obj, index, value, name, parent } = params;
  let formObj = props.localObj.forms.find((obj) => obj.parent === parent);
  let { formArr } = formObj;
  console.log("表单已更新", JSON.parse(JSON.stringify(formArr)));
  let address = formArr.find((obj) => obj.label === "服务器地址").value;
  let port = formArr.find((obj) => obj.label === "端口号").value;
  let { serverSaveQuery } = props.localObj.fn;
  let { status, result } = await serverSaveQuery?.({ address, port });
  if (!status) return globalThis.queryResult(status, result);
  globalThis.app.onRestart();
}

async function onUpload(paramObj = {}) {
  console.log("图片上传", paramObj);
  let { e, index, obj, parent } = paramObj;
  if (!e || !e.file) return console.log("图片上传失败");
  return await props.localObj.fn.loadData?.({ uploaders: { fileArr: e.file } });
}

function onUploadComplete(uploadArr) {
  console.log("图片上传完成", uploadArr);
}

function onRemove(paramObj) {
  console.log("图片删除", paramObj);
}
</script>

<style></style>
