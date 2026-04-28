export type NoticeType =
  | "科研"
  | "教学"
  | "研究生"
  | "学工"
  | "保密"
  | "国资"
  | "安全"
  | "国合"
  | "全院"
  | "行政"
  | "其他";

export interface Notice {
  id: string;
  type: NoticeType;
  title: string;
  body: string;
  publishDate: string;
  deadline: string | null;
  importance: 1 | 2 | 3;
  owner: string;
  links: string[];
  expired: boolean;
  createdAt: string;
}

export interface CategoryMeta {
  key: string;
  name: NoticeType;
  className: string;
  bgColor: string;
  kws: string[];
}
