<template>
  <!-- 对话框 -->
  <van-popup
    :show="localObj.dialogs.showPop"
    custom-class="my-pop"
    @close="togglePop"
    :round="true"
    position="bottom"
    :closeable="true"
    :close-icon="closeImg"
    selection-start="0"
    :selection-end="localObj.dialogs.value?.length"
    overlay-style="background-color: var(--overlay-background-color,rgba(0,0,0,0.2))"
  >
    <view style="height: 50vh">
      <view
        class="my-center my-center-vertically my-font my-big-font"
        style="padding: 1.875rem"
      >
        <view>车次</view>
      </view>
      <view style="padding: 0 6.4% 1.5rem 6.4%">
        <view class="my-pop-input my-center-vertically my-font my-far-table">
          <text v-if="!localObj.dialogs.editing" @tap="onInputStart">
            {{ localObj.dialogs.value || "请选择或输入车次" }}
          </text>
          <input
            v-if="localObj.dialogs.editing"
            :type="'digit'"
            :value="localObj.dialogs.value"
            :placeholder="'请选择或输入车次'"
            placeholder-class="my-font"
            :focus="true"
            @blur="(e) => onInputComplete(e.detail.value)"
          />
          <view style="padding: 1rem" @tap="toggleOption">
            <image
              style="width: 12px; height: 7px"
              src="../../../../assets/icon_pd.png"
            />
          </view>
        </view>
      </view>
    </view>
  </van-popup>
  <van-action-sheet
    :show="localObj.dialogs.showOptions"
    :actions="localObj.dialogs.optionArr"
    @select="onOptionSelect"
    @close="onOptionClose"
  />
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
import closeImg from "../../../../assets/icon_close.png";

definePageConfig({
  navigationStyle: "custom",
  usingComponents: {
    "van-popup": "@vant/weapp/popup/index",
    "van-action-sheet": "@vant/weapp/action-sheet/index",
  },
});

//父系入参
const { onNav, onNavBack } = globalThis.app;

const props = defineProps({
  globalObj: Object,
  localObj: Object,
});

function setData(obj) {
  Object.assign(props.localObj, obj);
}

//本地变量和函数

setData({
  dialogs: {
    value: "",
    parent: "对话框",
    showPop: false,
    showOptions: false,
    options: {
      carNo: [
        {
          label: "50",
          name: "50",
          value: "50",
        },
        {
          label: "80",
          name: "80",
          value: "80",
        },
        {
          label: "100",
          name: "100",
          value: "100",
        },
      ],
    },
    optionArr: [
      {
        label: "50",
        name: "50",
        value: "50",
      },
      {
        label: "80",
        name: "80",
        value: "80",
      },
      {
        label: "100",
        name: "100",
        value: "100",
      },
    ],
    togglePop,
  },
});

function togglePop() {
  console.log("切换对话框");
  let dialogs = props.localObj.dialogs;
  dialogs.showPop = !dialogs.showPop;
}

function toggleOption() {
  console.log("显示选项");
  let dialogs = props.localObj.dialogs;
  dialogs.showOptions = !dialogs.showOptions;
  dialogs.showPop === true && (dialogs.showPop = false);
}

async function onOptionSelect(e) {
  let { name, value } = e.detail;
  console.log("选择了选项", name, value);
  onInputComplete(value);
}
function onOptionClose(e) {
  console.log("关闭选项");
  let dialogs = props.localObj.dialogs;
  dialogs.showOptions = false;
}
function onInputStart() {
  let dialogs = props.localObj.dialogs;
  dialogs.editing = true;
}

function onInputComplete(value) {
  if (value !== undefined) props.localObj.dialogs.value = value;
  else value = props.localObj.dialogs.value;
  props.localObj.dialogs.editing = false;
  let params = { index: 0, value, parent: "筛选表单" };
  props.localObj.filters.forms[0].onEditComplete(params);
  //转交给对应的组件处理
}
</script>

<style>
.my-pop-input {
  background-color: #f7f7f7;
  color: #acacac;
  height: 3rem;
  padding-left: 4%;
  padding-right: 4%;
  border-radius: 2rem;
}
</style>
