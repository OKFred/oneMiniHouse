<template>
  <view class="table_box">
    <!-- 表头 -->
    <view class="tr bg-w my-center-vertically">
      <view v-for="(item, index) in localObj.tables.tableColumn" :key="index" :class="`th ${item.key === 'isPayment' ? ' isPayment' : ''} ${item.key === 'null' ? ' null' : ''
      }`" :style="`width: ${item.width ? item.width : 'auto'};`">
        {{ item.label }}
      </view>
    </view>
    <!-- 表体 -->
    <view class="tr bg-g my-center-vertically" v-for="(obj, i) in localObj.tables.tableRow" :key="i">
      <view v-for="(value, key, index) in obj" :key="index" :class="`td ${key === 'isPayment' ? ' isPayment' : ''} ${key === 'null' ? ' null' : ''
      }`" :style="`${key === 'isPayment' ? 'color:#07C160' : ''}`" @tap="onTableMenu(obj, i)">
        {{ value }}
      </view>
    </view>
    <!-- 汇总 -->
    <view class="tr bg-g my-center-vertically">
      <view v-for="(item, index) in localObj.tables.tableSummary" :key="index"
        :class="`summary ${item.key === 'total' ? 'total' : ''}`">
        {{ item.value }}
      </view>
    </view>
  </view>
  <view class="addCommodity_box" @tap="onAddProduct">
    <image src="../../../../assets/bnt.png" />
  </view>
  <van-action-sheet :show="localObj.tables.showOptions" :actions="localObj.tables.optionArr" @select="onOptionSelect"
    @close="toggleOption({ status: false })" />
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
const props = defineProps({
  localObj: Object,
});

function setData(obj) {
  Object.assign(props.localObj, obj);
}

//本地变量和函数
setData({
  tables: {
    tableColumn: [
      { label: "商品", key: "commodity", width: "4rem" },
      { label: "重量(kg)", key: "weight" },
      { label: "单价(元/kg)", key: "price" },
      { label: "小计(元)", key: "subtotal" },
      { label: "扣款(元)", key: "deduction" },
      // { label: "是否付款", key: "isPayment" },
      { label: "", key: "null" },
    ],
    tableRow: [
      {
        commodity: "大白菜",
        weight: "222",
        subtotal: "333",
        price: "1111",
        deduction: "5542",
        /* isPayment: "已付款", */
        null: "...",
      },
      {
        commodity: "大白菜",
        weight: "222",
        subtotal: "333",
        price: "999",
        deduction: "888",
        /* isPayment: "已付款", */
        null: "...",
      },
      {
        commodity: "大白菜",
        weight: "222",
        subtotal: "333",
        price: "777",
        deduction: "666",
        /* isPayment: "已付款", */
        null: "...",
      },
      {
        commodity: "大白菜",
        weight: "222",
        subtotal: "333",
        price: "555",
        deduction: "444",
        /* isPayment: "已付款", */
        null: "...",
      },
    ],
    tableSummary: [
      { label: "总计", key: "total", value: "总计" },
      { label: "总重量", key: "totalWeight", value: "31212" },
      { label: "总单价", key: "", value: "" },
      { label: "总金额", key: "totalAmount", value: "1111.22" },
      { label: "总扣款", key: "totalDeduction", value: "1111.22" },
      { label: "总付款", key: "totalPayment", value: "1111.22" },
      { label: "", key: "null", value: "" },
    ],

    showOptions: false,
    options: {
      carNo: [
      ],
    },
    optionArr: [
      {
        label: "编辑",
        name: "编辑",
        value: "编辑",
      },
      {
        label: "删除",
        name: "删除",
        value: "删除",
      },
      {
        label: "取消",
        name: "取消",
        value: "取消",
      },
    ],
    optionTarget: '',
  },
});

function onAddProduct() {
  console.log("销售单需要添加商品");
  globalThis.app.onNav({ pageName: "收入-销售单-添加商品", paramObj: { test: 'a' } });
}

function onTableMenu(obj, index) {
  console.log('第' + (index + 1) + '行需要操作');
  toggleOption({ status: true })
  props.localObj.tables.optionTarget = index;
}

function toggleOption({ status } = {}) {
  // console.log("显示选项");
  let { tables } = props.localObj;
  tables.showOptions = status !== undefined ? status : !tables.showOptions;
}

async function onOptionSelect(e) {
  let { name, value } = e.detail;
  // console.log("选择了选项", name, value);
  let index = props.localObj.tables.optionTarget;
  let obj = props.localObj.tables.tableRow[index]
  if (name === '取消') return toggleOption({ status: false })
  else if (name === '删除') {
    props.localObj.tables.tableRow.splice(props.localObj.tables.optionTarget, 1);
    return console.log('删除')
  }
  let editing = name === '编辑';
  globalThis.app.onNav({ pageName: "收入-销售单-添加商品", paramObj: { obj, index, name, value, editing } });
}
</script>

<style>
/* 商品列表 */
.table_box {
  margin-top: 32rpx;
}

.tr {
  display: flex;
  justify-content: space-between;
}

.bg-w {
  height: 2.7rem;
  padding: 0 32rpx;
  background: #d8e5f5;
  color: #486b95;
  border-radius: 16rpx 16rpx 0px 0px;
}

.bg-g {
  height: 2.7rem;
  padding: 0 32rpx;
  background-color: #fff;
  border-bottom: 1px solid #f7f6fb;
  color: #181818;
}

.tr .th,
.tr .td {
  padding: 0 0.2rem;
}

.tr .null {
  text-align: center;
}

.tr .total {
  color: #fa5151;
}

/* 添加商品 */
.addCommodity_box {
  display: flex;
  justify-content: center;
  background-color: #fff;
  padding: 34rpx 0;
  border-radius: 0px 0px 16rpx 16rpx;
}

.addCommodity_box image {
  width: 622rpx;
  height: 88rpx;
}
</style>
