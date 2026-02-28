import json
p='/data/projects/f19cf883-8e9f-4c6f-93b5-b2c849a58c00/rooms_from_image.json'
obj=json.load(open(p,'r',encoding='utf-8'))
print(type(obj).__name__)
if isinstance(obj,dict):
    print('keys', list(obj.keys())[:20])
    for k,v in obj.items():
        print('sample', k, type(v).__name__)
        if isinstance(v,list):
            print('list_len', len(v))
            if v:
                print('first_item_type', type(v[0]).__name__)
                print('first_item_preview', str(v[0])[:200])
        break
elif isinstance(obj,list):
    print('len', len(obj))
    if obj:
        print('first_type', type(obj[0]).__name__)
        print('first_item_preview', str(obj[0])[:200])
