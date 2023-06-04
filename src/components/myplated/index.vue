<template>
  <van-dialog :use-slot="true" title="请输入车牌" :show="parentObj.showPlate" :show-cancel-button="true"
    @close="parentObj.onPlateClose" @tap="submitNumber">
    <view style="
        display: flex;
        flex-direction: row-reverse;
        color: #4c91d9;
        padding-right: 0.5rem;
      " @tap.stop="parentObj.onPlateEdit">
      自由输入
      <van-icon name="edit" style="margin-left: 0.3rem" />
    </view>
    <input v-if="parentObj.editing" :type="'text'" :value="parentObj.plateNumber" :placeholder="'请输入'"
      placeholder-style="font-size: 1rem;" :focus="true" @tap.stop="(e) => { }"
      @blur.stop="(e) => onInputComplete(e.detail.value)" />
    <view class="carNumber" style="margin-top: 50rpx" v-if="!parentObj.editing">
      <view class="weui-cells__title"></view>
      <!-- 车牌号头两位 -->
      <view class="carNumber-items">
        <view class="carNumber-items-box" @tap.stop="parentObj.openKeyboard">
          <view class="carNumber-items-province carNumber-items-box-list">
            {{ parentObj.numberArr[0] || "" }}
          </view>
          <view class="carNumber-items-En carNumber-items-box-list">
            {{ parentObj.numberArr[1] || "" }}
          </view>
        </view>
        <!-- 常规 -->
        <view class="carNumber-item" @tap.stop="parentObj.openKeyboard">
          {{ parentObj.numberArr[2] || "" }}
        </view>
        <view class="carNumber-item" @tap.stop="parentObj.openKeyboard">
          {{ parentObj.numberArr[3] || "" }}
        </view>
        <view class="carNumber-item" @tap.stop="parentObj.openKeyboard">
          {{ parentObj.numberArr[4] || "" }}
        </view>
        <view class="carNumber-item" @tap.stop="parentObj.openKeyboard">
          {{ parentObj.numberArr[5] || "" }}
        </view>
        <view class="carNumber-item" @tap.stop="parentObj.openKeyboard">
          {{ parentObj.numberArr[6] || "" }}
        </view>
        <!-- 新能源 -->
        <view :class="`carNumber-item ${parentObj.showNewPower ? '' : 'carNumber-item-newpower'
          }`">
          <view v-if="!parentObj.showNewPower" @tap.stop="parentObj.showPowerBtn">
            <view class="carNumber-newpower-add">+</view>
            <view class="n_name">新能源</view>
          </view>
          <view v-if="parentObj.showNewPower" @tap.stop="parentObj.openKeyboard">
            {{ parentObj.numberArr[7] }}
          </view>
        </view>
      </view>
    </view>
    <!-- 提交车牌 -->
    <!-- <button class="carNumberBtn" @tap='submitNumber' style="background:  #DE5252;color:#fff;border-radius: 40rpx;" type="default">
    确定
  </button> -->
  </van-dialog>
  <!-- 虚拟键盘 -->
  <view class="keyboard" v-if="parentObj.KeyboardState">
    <view class="keyboardClose">
      <view class="keyboardClose_btn" @tap="parentObj.closeKeyboard">关闭</view>
    </view>
    <!-- 省份简写键盘 -->
    <view class="keyboard-item" v-if="!parentObj.numberArr[0]">
      <view class="keyboard-line" v-for="(item, index) in localObj.provinces" :key="index">
        <view :class="`keyboard-btn ${str === '云' ? 'keyboard-big-btn' : ''}`" @tap="bindChoose(str)"
          v-for="(str, index) in item" :key="index">
          {{ str }}
        </view>
      </view>
      <view class="keyboard-del" @tap="bindDelChoose">
        清除
        <text class="font_family icon-shanchu keyboard-del-font"></text>
      </view>
    </view>
    <!-- 车牌号码选择键盘 -->
    <view class="keyboard-item iscarnumber" v-if="parentObj.numberArr[0]">
      <view class="keyboard-line" v-for="(item, index) in localObj.numbers" :key="index">
        <view class="keyboard-btn" v-for="(str, index) in item" :key="index" @tap="bindChoose(str)">
          {{ str }}
        </view>
      </view>
      <view class="keyboard-del" @tap="bindDelChoose">
        清除
      </view>
    </view>
  </view>
</template>

<script setup>
import { reactive, watch, onMounted } from "vue";

//父系入参
const props = defineProps({
  parentObj: {
    type: Object,
    validator(obj) {
      if (obj) {
        if (
          typeof obj.onPlateEdit !== "function" ||
          typeof obj.onPlateClose !== "function" ||
          typeof obj.onPlateConfirm !== "function"
        )
          return console.log("⚠️表单处理函数未传入");
      }
    },
  },
});

//本地变量和函数
let localObj = reactive({
  // 省份简写
  provinces: [
    ["云", "京", "沪", "粤", "津", "冀", "晋", "蒙"],
    ["辽", "吉", "黑", "苏", "浙", "皖", "闽", "赣", "鲁", "豫"],
    ["鄂", "湘", "桂", "琼", "渝", "川", "贵", "藏", "陕", "甘"],
    ["青", "宁", "新"],
  ],
  // 车牌输入
  numbers: [
    ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
    ["A", "B", "C", "D", "E", "F", "G", "H", "J", "K"],
    ["L", "M", "N", "P", "Q", "R", "S", "T", "U", "V"],
    ["W", "X", "Y", "Z", "港", "澳", "学", "挂"],
  ],
});

function setData(obj) {
  Object.assign(localObj, obj);
}

// 选中点击设置(车牌号)
function bindChoose(value) {
  // console.log('输入了', value)
  if (!props.parentObj.numberArr[6] || props.parentObj.showNewPower) {
    let arr = [];
    arr[0] = value;
    props.parentObj.numberArr = props.parentObj.numberArr.concat(arr);
  }
}
function bindDelChoose() {
  if (props.parentObj.numberArr.length != 0) {
    props.parentObj.numberArr.splice(props.parentObj.numberArr.length - 1, 1);
  }
}
function showPowerBtn() {
  setData({
    showNewPower: true,
    KeyboardState: true,
  });
}
function closeKeyboard() {
  setData({
    KeyboardState: false,
  });
  console.log(localObj.KeyboardState)
}
function openKeyboard() {
  setData({
    KeyboardState: true,
  });
  console.log('显示键盘')
  console.log(localObj.KeyboardState)
}

function onInputComplete(value) {
  if (value !== undefined) props.parentObj.plateNumber = value;
  else value = props.parentObj.plateNumber;
  // console.log('完成输入', value)
}

// 提交车牌号码
function submitNumber() {
  let { numberArr, plateNumber } = props.parentObj;
  if (!plateNumber) {
    if (!props.parentObj.showNewPower) {
      if (!numberArr[6]) return globalThis.queryResult(false, "请填写完整的车牌号码")
    } else {
      if (!numberArr[7]) return globalThis.queryResult(false, "请填写完整的车牌号码")
    }
    plateNumber = numberArr.join('')
  }
  props.parentObj.onPlateConfirm({ plateNumber });
}
</script>

<style>
/* 车牌 */

.page {
  background: #fff;
  position: absolute;
  top: 0;
  bottom: 0;
  width: 100%;
}

.weui-cells__title {
  margin-top: 0.77em;
  margin-bottom: 0.3em;
  padding-left: 15px;
  padding-right: 15px;
  color: #999;
  font-size: 14px;
}

/* 虚拟键盘 */
.keyboard {
  height: auto;
  background: #d1d5d9;
  position: fixed;
  bottom: 174px;
  width: 100%;
  left: 0;
  z-index: 10000000000;
}

.keyboard-item {
  padding: 10px 0 5px 0;
  position: relative;
  display: block;
}

/* 关闭虚拟键盘 */
.keyboardClose {
  height: 70px;
  background-color: #f7f7f7;
  overflow: hidden;
}

.keyboardClose_btn {
  float: right;
  line-height: 70px;
  font-size: 30px;
  padding-right: 30px;
}

/* 虚拟键盘-省缩写 */

/* 虚拟键盘-行 */
.keyboard-line {
  margin: 0 auto;
  text-align: left;
}

.iscarnumber .keyboard-line {
  text-align: left;
  margin-left: 5px;
}

/* 虚拟键盘-单个按钮 */
.keyboard-btn {
  font-size: 34px;
  color: #333333;
  background: #fff;
  display: inline-block;
  padding: 18px 0;
  width: 63px;
  text-align: center;
  box-shadow: 0 2px 0 0 #999999;
  border-radius: 10px;
  margin: 5px 6px;
}

.keyboard-big-btn {
  font-size: 56px;
  padding: 36px 0;
  width: 163px;
}

/* 虚拟键盘-删除按钮 */
.keyboard-del {
  height: 60px;
  line-height: 60px;
  font-size: 34px;
  color: #333333;
  background: #a7b0bc;
  display: inline-block;
  padding: 4px 20px;
  box-shadow: 0 2px 0 0 #999999;
  border-radius: 10px;
  margin: 5px;
  position: absolute;
  bottom: 5px;
  right: 6px;
}

.keyboard-del-font {
  font-size: 25px;
}

/* 车牌号码 */
.carNumber-items {
  text-align: left;
  display: flex;
}

.carNumber-items-box {
  display: flex;
  width: 140px;
  height: 70px;
  border: 2px solid #cccccc;
  border-radius: 4px;
  position: relative;
  margin-right: 30px;
}

.carNumber-items-box-list {
  width: 70px;
  height: 70px;
  line-height: 70px;
  text-align: center;
  display: inline-block;
  font-size: 36px;
  /* margin:10px 0; */
  vertical-align: middle;
}

.carNumber-items-province {
  border-right: 1px solid #ccc;
}

.carNumber-items-box::after {
  content: "";
  width: 6px;
  height: 6px;
  position: absolute;
  right: -22px;
  top: 40px;
  border-radius: 50%;
  background-color: #ccc;
}

.carNumber-item {
  width: 70px;
  height: 70px;
  font-size: 36px;
  text-align: center;
  border: 2px solid #cccccc;
  border-radius: 4px;
  line-height: 70px;
  display: inline-block;
  margin: 0 4px;
  vertical-align: middle;
}

/* 新能源 */
.carNumber-item-newpower {
  border: 2px dashed #a8bff3;
  background-color: #f6f9ff;
  color: #a8bff3;
  font-size: 12px;
  line-height: 45px;
}

.carNumber-newpower-add {
  font-size: 36px;
}

/* 确认按钮 */
.carNumberBtn {
  border-radius: 4px;
  margin: 80px 40px;
}

.carNumber {
  padding: 0 10px;
  margin-bottom: 30px;
}

.n_name {
  font-size: 18px;
  margin-top: -10px;
}
</style>
