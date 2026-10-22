"""Seed ONLY the isolated learning v2 DB. Runtime application is native Cangjie.

Imported teaching content stays under ignored data/, never imports legacy users.
Requires pymysql for this one-time development/migration tool.
"""
from pathlib import Path
import argparse
import json
import re
import pymysql

ROOT=Path(__file__).resolve().parent.parent

def config():
    values={}
    for line in (ROOT/'.env.local').read_text(encoding='utf-8-sig').splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key,value=line.split('=',1);values[key.strip()]=value.strip()
    if values.get('ZHIXUN_DB_NAME')!='itn_learning_v2_dev':
        raise RuntimeError('Seed target must be the isolated itn_learning_v2_dev database')
    return values

def sections_from_content(value):
    if isinstance(value,str):
        try:value=json.loads(value)
        except (ValueError,TypeError):return []
    result=[]
    def collect(node,heading=''):
        if isinstance(node,list):
            for item in node:collect(item,heading)
        elif isinstance(node,dict):
            title=str(node.get('title') or node.get('heading') or node.get('name') or heading)
            body=node.get('content') or node.get('text') or node.get('body') or node.get('markdown')
            if isinstance(body,str) and len(body.strip())>30:
                result.append({'id':'section-'+str(len(result)),'eyebrow':'课程讲义','heading':title or '核心内容','text':body.strip()})
            elif isinstance(body,(dict,list)):collect(body,title)
            for key in ['chapters','sections','blocks','items']:
                if key in node:collect(node[key],title)
    collect(value)
    return result[:10]

def questions_from_content(value):
    if isinstance(value,str):
        try:value=json.loads(value)
        except (ValueError,TypeError):return []
    result=[]
    def collect(node):
        if isinstance(node,list):
            for item in node:collect(item)
        elif isinstance(node,dict):
            options=node.get('options') or node.get('choices')
            question=node.get('stem') or node.get('question') or node.get('text')
            answer=node.get('correctAnswer',node.get('correctIndex',node.get('answer',node.get('correct',node.get('correct_answer')))))
            if isinstance(question,str) and isinstance(options,list) and len(options)>=2:
                normalized=[]
                for option in options:
                    normalized.append(str(option.get('text') or option.get('content') or option.get('label') or '') if isinstance(option,dict) else str(option))
                if isinstance(answer,str):
                    if answer.upper() in ['A','B','C','D']:answer=ord(answer.upper())-65
                    elif answer.isdigit():answer=int(answer)
                    elif answer in normalized:answer=normalized.index(answer)
                if isinstance(answer,int) and not isinstance(answer,bool) and 0<=answer<len(normalized):
                    result.append({'id':'question-'+str(len(result)),'question':question,'options':normalized,'correct':answer,'explanation':str(node.get('explanation') or node.get('analysis') or '根据课程讲义中的定义与适用场景判断。'),'theoryTitle':str(node.get('knowledgePoint') or node.get('knowledge_point') or '核心概念')})
            else:
                for child in node.values():
                    if isinstance(child,(dict,list)):collect(child)
    collect(value)
    return result[:5]

def example_questions(course):
    facts={
      'ds': [('栈的基本访问顺序是什么？',['先进先出','后进先出','随机访问','按键排序'],1,'栈只在栈顶进行插入与删除，最后压入的元素先弹出。'),('顺序表按合法下标访问元素的时间复杂度是多少？',['O(1)','O(log n)','O(n)','O(n²)'],0,'顺序存储可以通过首地址、下标与元素大小直接计算地址。'),('在无权图中寻找最少边数的路径通常使用什么方法？',['深度优先搜索','广度优先搜索','任意排序','二分查找'],1,'广度优先搜索按距离起点的边数分层访问节点。')],
      'co': [('CPU执行程序时，下一条指令的地址通常由哪个寄存器保存？',['程序计数器PC','指令寄存器IR','累加器','状态寄存器'],0,'PC用于保存接下来将要获取的指令地址，IR保存当前指令。'),('高速缓存主要用于缓解哪两者之间的速度差异？',['CPU与主存','显示器与键盘','磁盘与打印机','网卡与路由器'],0,'Cache利用局部性保存常用数据，缓解CPU与主存的速度差异。'),('计算机通常使用什么形式表示和处理数据？',['十进制字符','二进制编码','仅自然语言','固定图像'],1,'计算机中的数据与指令通常采用二进制编码。')],
      'os': [('进程与线程的关系中，哪一项正确？',['线程是资源分配的唯一单位','同一进程的线程可以共享进程资源','进程不能包含线程','所有线程拥有独立地址空间'],1,'同一进程的多个线程共享地址空间等资源，但各有执行状态与栈。'),('互斥锁主要用于解决什么问题？',['增加磁盘容量','保护共享资源的并发访问','更改指令集','替代所有内存'],1,'互斥锁限制同一时刻进入临界区的执行者数量。'),('虚拟内存的作用包含哪一项？',['为程序提供地址空间抽象','让CPU不再执行指令','取消页面映射','让所有文件都常驻内存'],0,'虚拟内存通过地址映射提供隔离与地址空间抽象。')],
      'cn': [('IP协议主要负责什么？',['可靠的字节流重传','跨网络寻址与分组转发','定义网页布局','分配CPU时间片'],1,'IP负责网络层寻址与分组转发，可靠传输通常由更上层协议提供。'),('TCP与UDP的典型区别是什么？',['TCP提供可靠有序字节流','UDP必须三次握手','TCP不使用端口','UDP不能传输数据'],0,'TCP提供面向连接的可靠有序字节流；UDP提供数据报服务。'),('DNS的主要用途是什么？',['将域名解析为网络地址等记录','加密所有数据','代替路由协议','格式化文件系统'],0,'DNS负责查询域名对应的资源记录，例如A与AAAA记录。')],
      'agent': [('Agent与固定问答程序相比，典型特点是什么？',['只输出固定文本','围绕目标感知、规划并调用工具行动','永远不需要上下文','不能读取工具结果'],1,'Agent围绕目标根据环境与工具反馈调整下一步行动。'),('工具调用后，Agent通常应该如何继续？',['忽略执行结果','根据工具结果更新上下文再决定下一步','无条件重复同一调用','把所有结果视为成功'],1,'工具结果是后续决策的证据，失败和状态变化也必须反馈给Agent。'),('为学习导师保存用户偏好的合理目的是什么？',['使后续讲解更贴合学习目标','代替所有知识来源','确保每次都生成相同答案','禁止用户修改偏好'],0,'目标与偏好可以帮助调整讲解方式，用户应能更新自己的设置。')]
    }
    return [{'id':'question-'+str(i),'question':q,'options':opts,'correct':correct,'explanation':explanation,'theoryTitle':course['name']} for i,(q,opts,correct,explanation) in enumerate(facts[course['id']])]

def build_seed():
    fixture=json.loads((ROOT/'fixtures/course-catalog.json').read_text(encoding='utf8'))
    source=ROOT/'data/agent-source-resources.json'
    imported=json.loads(source.read_text(encoding='utf8')) if source.exists() else []
    lectures=[r for r in imported if r['resource_type']=='lecture' and sections_from_content(r['content_json'])]
    quizzes=[r for r in imported if r['resource_type']=='quiz' and questions_from_content(r['content_json'])]
    records=[]
    for course in fixture['courses']:
        course['sourceLabel']='旧库课程资料' if course['id']=='agent' and lectures else '示例课程'
        for index,chapter in enumerate(course['chapters']):
            facts=fixture['courseFacts'][course['id']]
            sections=[{'id':'section-'+str(i),'eyebrow':'核心概念' if i<2 else '学习方法','heading':chapter['title'] if i==0 else ['','理解工作过程','联系实际场景'][i],'text':fact+' 学习本节时，请结合具体输入、处理过程和输出结果解释这一结论，并通过例子检查自己的理解。'} for i,fact in enumerate(facts)]
            questions=example_questions(course);sources=[]
            if course['id']=='agent' and lectures:
                resource=lectures[index%len(lectures)];sections=sections_from_content(resource['content_json'])
                chapter['title']=str(resource['title'])[:180]
                sources=[{'id':resource['id'],'title':resource['title'],'kind':'legacy-resource'}]
                if quizzes:questions=questions_from_content(quizzes[index%len(quizzes)]['content_json'])
            slides=[{'title':section['heading'],'subtitle':'课程要点','bullets':[section['text'][:280]],'notes':section['text']} for section in sections]
            records.append({'courseId':course['id'],'lessonIndex':index,'title':chapter['title'],'content':{'sections':sections,'slides':slides,'sourceLabel':course['sourceLabel']},'questions':questions,'sources':sources})
    result={'courses':fixture['courses'],'lessons':records,'importedLectureCount':len(lectures),'importedQuizCount':len(quizzes)}
    (ROOT/'data').mkdir(exist_ok=True)
    (ROOT/'data/catalog-seed.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
    return result

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--build-only',action='store_true');args=parser.parse_args()
    seed=build_seed()
    if args.build_only:
        print('Built seed:',len(seed['courses']),'courses',len(seed['lessons']),'lessons');return
    env=config()
    conn=pymysql.connect(host=env['ZHIXUN_DB_HOST'],port=int(env['ZHIXUN_DB_PORT']),user=env['ZHIXUN_DB_USER'],password=env['ZHIXUN_DB_PASSWORD'],database=env['ZHIXUN_DB_NAME'],charset='utf8mb4',connect_timeout=10,read_timeout=30)
    try:
        with conn.cursor() as q:
            q.execute('SELECT COUNT(*) FROM courses')
            if q.fetchone()[0]:raise RuntimeError('Course catalog is not empty; refusing an implicit reseed')
            for c in seed['courses']:
                q.execute('INSERT INTO courses(id,name,icon,description,level,duration,chapters_json,source_label) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)',(c['id'],c['name'],c['icon'],c['description'],c['level'],c['duration'],json.dumps(c['chapters'],ensure_ascii=False),c['sourceLabel']))
            for lesson in seed['lessons']:
                q.execute('INSERT INTO lessons(course_id,lesson_index,title,content_json,quiz_json,sources_json) VALUES(%s,%s,%s,%s,%s,%s)',(lesson['courseId'],lesson['lessonIndex'],lesson['title'],json.dumps(lesson['content'],ensure_ascii=False),json.dumps(lesson['questions'],ensure_ascii=False),json.dumps(lesson['sources'],ensure_ascii=False)))
        conn.commit()
    except Exception:
        conn.rollback();raise
    finally:conn.close()
    print('Seeded isolated database:',len(seed['courses']),'courses,',len(seed['lessons']),'lessons; reusable lecture/quiz resources:',seed['importedLectureCount'],seed['importedQuizCount'])

if __name__=='__main__':main()
