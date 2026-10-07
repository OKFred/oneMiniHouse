<template>
  <!-- 名片 -->
  <view style="padding: 2vh 4vw; z-index: 12; position: relative;" class="my-far-table my-center-vertically">
    <view class="my-center my-center-vertically">
      <u-upload @afterRead="(e) => !localObj.readOnly && onUpload({ e })" :deletable="false" :previewFullImage="false"
        @tap="(e) => !localObj.readOnly && onRemove({ e })" :fileList="localObj.profiles.valueArr" name="头像" multiple
        :maxCount="1" width="48px" height="48px">
        <u-avatar :src="localObj.profiles.valueArr?.[0]" size="48px" :mp-avatar="true" />
      </u-upload>
      <view style="flex-direction: column; margin-left: 2vw" class="my-center" v-if="false">
        <view style="font-size: 1.2rem; margin-bottom: 2vh;">
          {{ localObj.profiles['用户名'] || "欢迎" }}
        </view>
        <view style="font-size: 1rem; font-weight: normal">
          手机号：{{ localObj.profiles['手机号'] || "" }}
        </view>
        <!-- 支持行内编辑 -->
        <!-- <input v-if=" localObj.profiles.editing " :value="localObj.profiles.name" :border="false" auto-focus @blur="onNameEditComplete" :placeholder="localObj.profiles.placeholder" placeholder-class="" style="width: 45vw" input-class="my-input" class="my-input-field" clearable />
          <view class="my-subtitle">{{ localObj.profiles.realName }}</view> -->
      </view>
    </view>
    <view class="my-center my-center-vertically" v-if="false">
      <view>个人资料</view>
      <u-icon name="arrow-right" style="margin-left: 0.3rem" />
    </view>
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
  profiles: {
    editing: false,
    placeholder: "请输入姓名",
    valueArr: []
  },
  uploaders: {
    onUploadComplete,
    uploadTarget: ""
  }
});

function onUpload(paramObj = {}) {
  return console.log("图片上传", paramObj);
  let { e } = paramObj;
  if (!e || !e.file) return console.log("图片上传失败");
  if (props.localObj.uploaders.uploadTarget) {
    return console.log("请等待上一张图片上传完成");
  }
  props.localObj.uploaders.uploadTarget = paramObj;
  props.localObj.fn.loadData?.({ uploaders: { fileArr: e.file } });
}

function onUploadComplete(uploadArr) {
  props.localObj.profiles.valueArr = [...props.localObj.profiles.valueArr, ...uploadArr.map(str => ({ url: str }))];
  if (props.localObj.profiles.valueArr.length > 1) {
    props.localObj.profiles.valueArr.length = 1;
  };
  props.localObj.uploaders.uploadTarget = "";
  console.log("图片上传完成", uploadArr);
}

function onRemove(paramObj) {
  console.log("图片删除", paramObj);
  props.localObj.profiles.valueArr = [];
}
</script>

<style>
.my-subtitle {
  font-size: 1rem;
  color: #8C8C8C;
  font-weight: 700;
}
</style>
