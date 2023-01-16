<template>
  <view v-for="(obj, index) in localObj.formArr" :key="index"
    :class="'my-far-table ' + (obj.inline ? 'my-form-inline' : '')" :style="
      'padding: 0.8rem 0; border-radius: 0; width:' +
      (obj.valueWidth || '100%') +
      (index + 1 < localObj.formArr.length && !obj.inline
        ? ';border-bottom: 0.1rem solid #f5f5f5;'
        : ';')
    ">
    <view class="my-center-vertically">
      <text class="my-inline-label" v-if="obj.labelDot" />
      <text class="my-inline-label-transparent" v-else-if="obj.prefix">
        {{ obj.prefix }}
      </text>
      <text class="my-font my-inline-text" v-if="!obj.labelHidden">
        {{ obj.label }}：
      </text>
    </view>
    <view style="color: #7b7b7b;" class="my-far-table" v-show="!obj.editing" @tap="
      (e) => parentObj.onEdit({ e, obj, index, parent: parentObj.parent })
    ">
      <view v-if="obj.type === 'realTime'" class="my-far-table" style="width: 100%">
        <text />
        <picker mode="date" :value="obj.value" :onChange="
          (e) =>
            parentObj.onEditComplete({
              e,
              obj,
              index,
              parent: parentObj.parent,
            })
        ">
          <text class="my-inline-text my-ellipsis">
            {{ obj.value || "请输入时间" }}
          </text>
        </picker>
      </view>
      <picker v-else-if="obj.type === 'realRegion'" mode="region" :value="localObj.currentRegion" :onChange="
        (e) =>
          parentObj.onRegionChange({
            e,
            ...e.detail,
            index,
            parent: parentObj.parent,
          })
      " level="region">
        <text class="my-inline-text my-ellipsis my-region-text">
          {{ obj.value }}
        </text>
      </picker>
      <view v-else class="my-center-vertically my-value-area"><text />
        <text
          :style="` text-overflow: unset; margin-left: 0.5rem; color: ${obj.value ? (obj.valueColor ? obj.valueColor : '#181818') : obj.placeholderColor ? obj.placeholderColor : '#ACACAC'};`"
          class="my-inline-text my-ellipsis">
          {{ obj.name || obj.value || obj.placeholder }}
        </text>
        <text v-if="obj.postfix"
          :style="`margin-left: 0.3rem; color: ${obj.postfixColor ? obj.postfixColor : '#181818'};`">
          {{ obj.postfix }}
        </text>
      </view>
      <van-icon v-show="obj.type === 'select' || obj.type === 'selectArea'" name="arrow" style="margin-left: 0.3rem" />
    </view>
    <!-- 支持行内编辑 -->
    <input v-if="obj.editing" :type="obj.type" :value="obj.value" :placeholder="obj.placeholder"
      placeholder-class="my-font" class="my-input" :focus="true" selection-start="0" :selection-end="obj.value.length"
      @blur="
  (e) =>
    parentObj.onEditComplete({
      obj,
      index,
      ...e.detail,
      parent: parentObj.parent,
    })
      " />
  </view>
</template>

<script setup>
import Taro from "@tarojs/taro";
import { reactive, watch, onMounted } from "vue";

//父系入参
const props = defineProps({
  parentObj: {
    type: Object,
    validator(obj) {
      if (obj) {
        if (
          typeof obj.onEdit !== "function" ||
          typeof obj.onEditComplete !== "function"
        )
          return console.log("⚠️表单处理函数未传入");
      }
    },
  },
});

//本地变量和函数
let localObj = reactive({
  formArr: [],
  currentRegion: [24, 2, 2], //云南省,玉溪市,通海县
});

onMounted(() => {
  // console.log("加载组件listd");
});

definePageConfig({
  navigationStyle: "custom",
  usingComponents: {
    "van-field": "@vant/weapp/field/index",
    "van-icon": "@vant/weapp/icon/index",
  },
});

watch(
  () => props.parentObj.formArr,
  (newValue, oldValue) => {
    if (newValue && newValue.length) {
      localObj.formArr = newValue.filter((obj) => !obj.hidden);
      // console.log(localObj.formArr);
    } //通过hidden 关键词 隐藏某项表单值
  },
  { immediate: true }
);
</script>

<style>
.my-input {
  width: 45vw;
  text-align: center !important;
  font-size: 1rem;
  padding: 0 !important;
}

.my-form-inline {
  display: inline-flex;
}

.my-inline-label-transparent {
  display: inline-block;
  background-color: transparent;
  height: 0.5rem;
  width: 0.5rem;
  margin-left: 1.5vw;
  margin-right: 1.5vw;
  border-radius: 50%;
}

.my-region-text {
  display: flex;
  flex-direction: row-reverse;
  text-overflow: unset;
  width: 43vw;
}

.my-value-area {
  width: 100%;
  display: flex;
  justify-content: flex-end;
  height: auto;
}
</style>
