<template>
  <!-- 筛选器 -->
  <view>
    <weform :parentObj="localObj.filters">
      <template #datePicker>
        <text @tap="setFilter('dateStart')">
          {{ localObj.filters.data.dateStart || "请选择到货时间" }}
        </text>
      </template>
    </weform>
    <text>~</text>
    <weform :parentObj="localObj.filters">
      <template #datePicker>
        <text @tap="setFilter('dateEnd')">
          {{ localObj.filters.data.dateEnd || "请选择售完时间" }}
        </text>
      </template>
    </weform>
    <text style="color: #7b7b7b">▼</text>
  </view>
  <view style="margin-top: 1rem" />
  <view class="white-container">
    <myCardsListd :parentObj="localObj.filters.forms[0]" />
  </view>
  <view class="my-far-table" style="margin-top: 0.5rem">
    <view />
    <view class="my-inline-text" style="color: #fa5151">
      该车次没有关联商品单，请添加商品单
    </view>
  </view>
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
import weform from "@/src/components/weform/index.vue"; //引入组件
import myCardsListd from "@/src/components/mycards-listd/index.vue"; //引入组件

definePageConfig({
  navigationStyle: "custom",
  usingComponents: {},
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
  filters: {
    key: "",
    type: "date",
    data: {
      dateStart: "",
      dateEnd: "",
      region: [],
    },
    onDateChange,
    // onTimeChange,
    // onRegionChange,
    forms: [
      {
        onEdit,
        onEditComplete,
        parent: "筛选表单",
        formArr: [
          {
            key: "carNo",
            label: "车次",
            value: "",
            editing: false,
            type: "select",
            placeholder: "请选择或输入车次",
          },
          {
            key: "productNo",
            label: "商品单",
            value: "",
            editing: false,
            type: "select",
            placeholder: "请输入该车次商品",
          },
        ],
      },
    ],
  },
});

function setFilter(key) {
  props.localObj.filters.key = key;
}

function onDateChange(params) {
  let { value } = params;
  let { data, key } = props.localObj.filters;
  data[key] = value;
}

function onTimeChange(params) {
  let { value } = params;
  let { data, key } = props.localObj.filters;
  data[key] = value;
}

function onRegionChange(params) {
  let { value = [], code = "", postcode = [] } = params;
  let { data, key } = props.localObj.filters;
  data[key] = value;
}

function onEdit(params) {
  let { obj, index, parent } = params;
  let { formArr } = props.localObj.filters.forms.find(
    (obj) => obj.parent === parent
  );
  // console.log("开始填写表单", obj, index);
  if (/车次/.test(obj.label)) {
    return props.localObj.dialogs.togglePop();
  } else if (/商品单/.test(obj.label)) {
    return globalThis.app.onNav({ pageName: "收入-销售单-商品单", paramObj: params });
  }
  let { type, option } = obj;
  if (type === undefined) {
    return console.log("只读");
  } else if (type === "plateNumber") {
    try {
      Taro.chooseLicensePlate({
        success: (e) => {
          console.log(e);
          formArr[index].value = e.plateNumber;
        },
        fail: (e) => {
          console.log("用户取消输入", e);
          formArr[index].value = "";
        },
      }); //微信自带车牌号输入模块，根据后端反馈修改 20221029
    } catch (e) {
      globalThis.queryResult(false, "请更新微信版本");
    }
  } else if (type === "text" || type === "number" || type === "digit") {
    formArr[index].editing = true;
  } else if (type === "plateNo") {
    props.localObj.showPlate = true;
  } else if (type === "select") {
    let showOptions = true;
    let optionArr = props.localObj.options[option];
    if (!optionArr || optionArr.length === 0) {
      optionArr = [];
      globalThis.queryResult(false, "选项缺失");
    }
    let optionTarget = { index, parent }; //方便选择之后定位所属的表单项目
    setData({ showOptions, optionArr, optionTarget, needCalc });
  } else if (type === "selectArea") {
    let showArea = true;
    let optionTarget = { index, parent }; //方便选择之后定位所属的表单项目
    setData({ showArea, optionTarget });
  }
}

function onEditComplete(params) {
  let { obj, index, value, parent } = params;
  let { formArr } = props.localObj.filters.forms.find(
    (obj) => obj.parent === parent
  );
  formArr[index].value = value;
  formArr[index].editing = false;
  console.log("表单已更新", JSON.parse(JSON.stringify(formArr)));
  props.localObj.fetchData();
}
</script>

<style>

</style>
