"""Run normally or with python3 -O; does not contact Docker or a database."""
import unittest,copy
from guards import validate_container,validate_digest,validate_cron,CONTAINER_ID,IMAGE_ID
class GuardTests(unittest.TestCase):
    def setUp(self):
        self.valid={'Id':CONTAINER_ID,'Image':IMAGE_ID,'Config':{'Labels':{'purpose':'sandra-inbox-projection-t2'}},'State':{'Running':True},'HostConfig':{'NetworkMode':'none','PortBindings':{},'Memory':536870912,'NanoCpus':1000000000}}
    def test_valid(self):
        validate_container(self.valid);validate_cron('off');validate_digest('abc','abc','test')
    def test_reject_container_mutations(self):
        for path,value in [(('Id',),'other'),(('Image',),'other'),(('Config','Labels','purpose'),'other'),(('State','Running'),False),(('HostConfig','NetworkMode'),'bridge'),(('HostConfig','PortBindings'),{'5432/tcp':[{'HostPort':'5432'}]}),(('HostConfig','Memory'),0),(('HostConfig','NanoCpus'),0)]:
            d=copy.deepcopy(self.valid);node=d
            for key in path[:-1]:node=node[key]
            node[path[-1]]=value
            with self.subTest(path=path),self.assertRaises(RuntimeError):validate_container(d)
    def test_digest_mismatch(self):
        with self.assertRaises(RuntimeError):validate_digest('modified','recorded','vendor or applied source')
    def test_cron(self):
        for value in ['on','',None]:
            with self.subTest(value=value),self.assertRaises(RuntimeError):validate_cron(value)
if __name__=='__main__':unittest.main()
